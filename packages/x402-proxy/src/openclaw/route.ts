import type { IncomingMessage, ServerResponse } from "node:http";
import type { MppProxyHandler, X402ProxyHandler } from "../handler.js";
import { extractTxSignature, TEMPO_NETWORK } from "../handler.js";
import { appendHistory } from "../history.js";
import type { ResolvedProviderConfig } from "./defaults.js";
import { type ModelEntry, parseMppAmount, paymentAmount, SOL_MAINNET } from "./tools.js";

const debug = process.env.X402_PROXY_DEBUG === "1";
function dbg(msg: string): void {
  if (debug) process.stderr.write(`[x402-proxy] ${msg}\n`);
}

export type InferenceProxyRouteOptions = {
  providers: ResolvedProviderConfig[];
  getX402Proxy: () => X402ProxyHandler | null;
  getMppHandler: () => MppProxyHandler | null;
  getWalletAddress: () => string | null;
  getWalletAddressForNetwork?: (network: string) => string | null;
  historyPath: string;
  allModels: Pick<ModelEntry, "provider" | "id">[];
  logger: { info: (msg: string) => void; error: (msg: string) => void };
};

export function createInferenceProxyRouteHandler(
  opts: InferenceProxyRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const {
    providers,
    getX402Proxy,
    getMppHandler,
    getWalletAddress,
    getWalletAddressForNetwork,
    historyPath,
    allModels,
    logger,
  } = opts;

  const sortedProviders = providers
    .slice()
    .sort((left, right) => right.baseUrl.length - left.baseUrl.length);

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const provider = sortedProviders.find(
      (entry) => entry.baseUrl === "/" || url.pathname.startsWith(entry.baseUrl),
    );

    if (!provider) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unknown inference route", code: "not_found" } }));
      return true;
    }

    const walletAddress = getWalletAddress();
    if (!walletAddress) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Wallet not loaded yet", code: "not_ready" } }));
      return true;
    }

    const pathSuffix =
      provider.baseUrl === "/" ? url.pathname : url.pathname.slice(provider.baseUrl.length);
    const upstreamBase = provider.upstreamUrl.replace(/\/+$/, "");
    const normalizedPath = pathSuffix.startsWith("/") ? pathSuffix : `/${pathSuffix}`;
    const upstreamUrl = `${upstreamBase}${normalizedPath}${url.search}`;

    dbg(`${req.method} ${url.pathname} -> ${upstreamUrl}`);
    logger.info(`proxy: intercepting ${upstreamUrl.substring(0, 80)}`);

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let body = Buffer.concat(chunks).toString("utf-8");

    const HOP_BY_HOP = new Set([
      "authorization",
      "host",
      "connection",
      "content-length",
      "transfer-encoding",
      "keep-alive",
      "te",
      "upgrade",
    ]);
    const headers: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(key)) continue;
      if (typeof val === "string") headers[key] = val;
    }

    const isChatCompletion = pathSuffix.includes("/chat/completions");
    const isMessagesApi = pathSuffix.includes("/messages");
    const isLlmEndpoint = isChatCompletion || isMessagesApi;
    let thinkingMode: string | undefined;
    if (isChatCompletion && body) {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (parsed.reasoning_effort) thinkingMode = String(parsed.reasoning_effort);
        if (!parsed.stream_options) {
          parsed.stream_options = { include_usage: true };
          body = JSON.stringify(parsed);
        }
      } catch {
        // not JSON body, leave as-is
      }
    }
    if (isMessagesApi && body) {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const thinking = parsed.thinking as { type?: string; budget_tokens?: number } | undefined;
        if (thinking?.type === "enabled" && thinking.budget_tokens) {
          thinkingMode = `budget_${thinking.budget_tokens}`;
        }
      } catch {
        // not JSON body, leave as-is
      }
    }

    const method = req.method ?? "GET";
    const startMs = Date.now();

    try {
      const requestInit: RequestInit = {
        method,
        headers,
        body: ["GET", "HEAD"].includes(method) ? undefined : body,
      };
      const useMpp = provider.protocol === "mpp" || provider.protocol === "auto";
      const wantsStreaming = isLlmEndpoint && /"stream"\s*:\s*true/.test(body);

      if (useMpp) {
        const mpp = getMppHandler();
        if (!mpp) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message:
                  "MPP inference requires an EVM wallet. Configure X402_PROXY_WALLET_MNEMONIC or X402_PROXY_WALLET_EVM_KEY.",
                code: "mpp_wallet_missing",
              },
            }),
          );
          return true;
        }
        const mppWalletAddress = getWalletAddressForNetwork?.(TEMPO_NETWORK) ?? walletAddress;
        return await handleMppRequest({
          res,
          upstreamUrl,
          requestInit,
          walletAddress: mppWalletAddress,
          historyPath,
          logger,
          allModels,
          thinkingMode,
          wantsStreaming,
          isMessagesApi,
          startMs,
          mpp,
        });
      }

      const proxy = getX402Proxy();
      if (!proxy) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message:
                "x402 wallet not loaded yet. Configure a Solana wallet or switch the provider to mpp.",
              code: "x402_wallet_missing",
            },
          }),
        );
        return true;
      }

      const response = await proxy.x402Fetch(upstreamUrl, requestInit);

      if (response.status === 402) {
        const responseBody = await response.text();
        logger.error(`x402: payment failed, raw response: ${responseBody}`);
        const payment = proxy.shiftPayment();
        const amount = paymentAmount(payment);
        const paymentFrom =
          (payment?.network && getWalletAddressForNetwork?.(payment.network)) ?? walletAddress;
        const paymentNetwork = payment?.network ?? SOL_MAINNET;
        appendHistory(historyPath, {
          t: Date.now(),
          ok: false,
          kind: "x402_inference",
          net: paymentNetwork,
          from: paymentFrom,
          to: payment?.payTo,
          amount,
          token: amount != null ? "USDC" : undefined,
          ms: Date.now() - startMs,
          error: "payment_required",
        });

        let userMessage: string;
        if (responseBody.includes("simulation") || responseBody.includes("Simulation")) {
          userMessage = `Insufficient USDC or SOL in wallet ${walletAddress}. Fund it with USDC (SPL token) to pay for inference.`;
        } else if (responseBody.includes("insufficient") || responseBody.includes("balance")) {
          userMessage = `Insufficient funds in wallet ${walletAddress}. Top up with USDC on Solana mainnet.`;
        } else {
          userMessage = `x402 payment failed: ${responseBody.substring(0, 200) || "unknown error"}. Wallet: ${walletAddress}`;
        }

        writeErrorResponse(
          res,
          402,
          userMessage,
          "x402_payment_error",
          "payment_failed",
          isMessagesApi,
        );
        return true;
      }

      if (!response.ok && isLlmEndpoint) {
        const responseBody = await response.text();
        logger.error(`x402: upstream error ${response.status}: ${responseBody.substring(0, 300)}`);
        const payment = proxy.shiftPayment();
        const amount = paymentAmount(payment);
        const paymentFrom =
          (payment?.network && getWalletAddressForNetwork?.(payment.network)) ?? walletAddress;
        const paymentNetwork = payment?.network ?? SOL_MAINNET;
        appendHistory(historyPath, {
          t: Date.now(),
          ok: false,
          kind: "x402_inference",
          net: paymentNetwork,
          from: paymentFrom,
          to: payment?.payTo,
          amount,
          token: amount != null ? "USDC" : undefined,
          ms: Date.now() - startMs,
          error: `upstream_${response.status}`,
        });

        writeErrorResponse(
          res,
          502,
          `LLM provider temporarily unavailable (HTTP ${response.status}). Try again shortly.`,
          "x402_upstream_error",
          "upstream_failed",
          isMessagesApi,
        );
        return true;
      }

      logger.info(`x402: response ${response.status}`);

      const txSig = extractTxSignature(response);
      const payment = proxy.shiftPayment();
      const amount = paymentAmount(payment);
      const paymentFrom =
        (payment?.network && getWalletAddressForNetwork?.(payment.network)) ?? walletAddress;
      const paymentNetwork = payment?.network ?? SOL_MAINNET;

      const resHeaders: Record<string, string> = {};
      for (const [key, val] of response.headers.entries()) {
        resHeaders[key] = val;
      }
      res.writeHead(response.status, resHeaders);

      if (!response.body) {
        res.end();
        appendHistory(historyPath, {
          t: Date.now(),
          ok: true,
          kind: "x402_inference",
          net: paymentNetwork,
          from: paymentFrom,
          to: payment?.payTo,
          tx: txSig,
          amount,
          token: "USDC",
          ms: Date.now() - startMs,
        });
        return true;
      }

      const ct = response.headers.get("content-type") || "";
      const isSSE = isLlmEndpoint && ct.includes("text/event-stream");
      const sse = isSSE ? createSseTracker() : null;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
          sse?.push(decoder.decode(value, { stream: true }));
        }
      } finally {
        reader.releaseLock();
      }
      res.end();

      appendInferenceHistory({
        historyPath,
        allModels,
        walletAddress: paymentFrom,
        paymentNetwork,
        paymentTo: payment?.payTo,
        tx: txSig,
        amount,
        thinkingMode,
        usage: sse?.result,
        durationMs: Date.now() - startMs,
      });
      return true;
    } catch (err) {
      const msg = String(err);
      logger.error(`x402: fetch threw: ${msg}`);
      getX402Proxy()?.shiftPayment();
      appendHistory(historyPath, {
        t: Date.now(),
        ok: false,
        kind: "x402_inference",
        net: SOL_MAINNET,
        from: walletAddress,
        ms: Date.now() - startMs,
        error: msg.substring(0, 200),
      });

      let userMessage: string;
      if (msg.includes("Simulation failed") || msg.includes("simulation")) {
        userMessage = `Insufficient USDC or SOL in wallet ${walletAddress}. Fund it with USDC and SOL to pay for inference.`;
      } else if (msg.includes("Failed to create payment")) {
        userMessage = `x402 payment creation failed: ${msg}. Wallet: ${walletAddress}`;
      } else {
        userMessage = `x402 request failed: ${msg}`;
      }

      if (!res.headersSent) {
        writeErrorResponse(
          res,
          402,
          userMessage,
          "x402_payment_error",
          "payment_failed",
          isMessagesApi,
        );
      }
      return true;
    }
  };
}

export function writeErrorResponse(
  res: ServerResponse,
  status: number,
  message: string,
  type: string,
  code: string,
  isAnthropicFormat: boolean,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  if (isAnthropicFormat) {
    res.end(JSON.stringify({ type: "error", error: { type, message } }));
  } else {
    res.end(JSON.stringify({ error: { message, type, code } }));
  }
}

export type InferenceUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export function createSseTracker() {
  let residual = "";
  // Anthropic accumulated state
  let anthropicModel = "";
  let anthropicInputTokens = 0;
  let anthropicOutputTokens = 0;
  let anthropicCacheRead: number | undefined;
  let anthropicCacheWrite: number | undefined;
  // OpenAI: last data line with usage
  let lastOpenAiData = "";
  let isAnthropic = false;

  function processJson(json: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }

    const type = parsed.type as string | undefined;

    // Anthropic streaming events
    if (type === "message_start") {
      isAnthropic = true;
      const msg = parsed.message as Record<string, unknown> | undefined;
      anthropicModel = (msg?.model as string) ?? "";
      const u = msg?.usage as Record<string, number | null> | undefined;
      if (u) {
        anthropicInputTokens = u.input_tokens ?? 0;
        anthropicCacheWrite = u.cache_creation_input_tokens ?? undefined;
        anthropicCacheRead = u.cache_read_input_tokens ?? undefined;
      }
      return;
    }
    if (type === "message_delta") {
      isAnthropic = true;
      const u = parsed.usage as Record<string, number | null> | undefined;
      if (u?.output_tokens != null) anthropicOutputTokens = u.output_tokens;
      return;
    }
    // Anthropic non-streaming complete response
    if (type === "message") {
      isAnthropic = true;
      anthropicModel = (parsed.model as string) ?? "";
      const u = parsed.usage as Record<string, number | null> | undefined;
      if (u) {
        anthropicInputTokens = u.input_tokens ?? 0;
        anthropicOutputTokens = u.output_tokens ?? 0;
        anthropicCacheWrite = u.cache_creation_input_tokens ?? undefined;
        anthropicCacheRead = u.cache_read_input_tokens ?? undefined;
      }
      return;
    }

    // OpenAI: keep last chunk that has usage
    if (parsed.usage || parsed.model) lastOpenAiData = json;
  }

  return {
    /** Push raw SSE bytes - for x402 path (contains "event:"/"data:" framing) */
    push(text: string): void {
      const combined = residual + text;
      const lines = combined.split("\n");
      residual = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          processJson(line.slice(6));
        }
      }
    },
    /** Push raw JSON payload - for MPP path (no SSE framing) */
    pushJson(text: string): void {
      processJson(text);
    },
    /** Parsed usage result, or undefined if nothing was captured */
    get result(): InferenceUsage | undefined {
      if (isAnthropic) {
        if (!anthropicModel && !anthropicInputTokens && !anthropicOutputTokens) return undefined;
        return {
          model: anthropicModel,
          inputTokens: anthropicInputTokens,
          outputTokens: anthropicOutputTokens,
          cacheRead: anthropicCacheRead,
          cacheWrite: anthropicCacheWrite,
        };
      }
      if (!lastOpenAiData) return undefined;
      try {
        const parsed = JSON.parse(lastOpenAiData) as {
          model?: string;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: {
              cached_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            completion_tokens_details?: { reasoning_tokens?: number };
          };
        };
        return {
          model: parsed.model ?? "",
          inputTokens: parsed.usage?.prompt_tokens ?? 0,
          outputTokens: parsed.usage?.completion_tokens ?? 0,
          reasoningTokens: parsed.usage?.completion_tokens_details?.reasoning_tokens,
          cacheRead: parsed.usage?.prompt_tokens_details?.cached_tokens,
          cacheWrite: parsed.usage?.prompt_tokens_details?.cache_creation_input_tokens,
        };
      } catch {
        return undefined;
      }
    },
  };
}

type HandleMppRequestOptions = {
  res: ServerResponse;
  upstreamUrl: string;
  requestInit: RequestInit;
  walletAddress: string;
  historyPath: string;
  logger: { info: (msg: string) => void; error: (msg: string) => void };
  allModels: Pick<ModelEntry, "provider" | "id">[];
  thinkingMode?: string;
  wantsStreaming: boolean;
  isMessagesApi: boolean;
  startMs: number;
  mpp: MppProxyHandler;
};

export async function handleMppRequest(opts: HandleMppRequestOptions): Promise<boolean> {
  const {
    res,
    upstreamUrl,
    requestInit,
    walletAddress,
    historyPath,
    logger,
    allModels,
    thinkingMode,
    wantsStreaming,
    isMessagesApi,
    startMs,
    mpp,
  } = opts;

  try {
    if (wantsStreaming) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      const sse = createSseTracker();
      dbg(`mpp.sse() calling ${upstreamUrl}`);
      const stream = await mpp.sse(upstreamUrl, requestInit);
      dbg("mpp.sse() resolved, iterating stream");
      if (isMessagesApi) {
        for await (const chunk of stream) {
          const text = String(chunk);
          let eventType = "unknown";
          try {
            eventType = (JSON.parse(text) as { type?: string }).type ?? "unknown";
          } catch {}
          res.write(`event: ${eventType}\ndata: ${text}\n\n`);
          sse.pushJson(text);
        }
      } else {
        for await (const chunk of stream) {
          const text = String(chunk);
          res.write(`data: ${text}\n\n`);
          sse.pushJson(text);
        }
        res.write("data: [DONE]\n\n");
      }
      dbg(
        `stream done, ${sse.result ? `${sse.result.model} ${sse.result.inputTokens}+${sse.result.outputTokens}t` : "no usage"}`,
      );
      res.end();
      mpp.shiftPayment(); // discard session-open marker pushed by sse()
      // Per-request amount is not available for session-based streaming;
      // the session stays open for reuse and settles on shutdown.
      appendInferenceHistory({
        historyPath,
        allModels,
        walletAddress,
        paymentNetwork: TEMPO_NETWORK,
        paymentTo: undefined,
        thinkingMode,
        usage: sse.result,
        durationMs: Date.now() - startMs,
      });
      return true;
    }

    const response = await mpp.fetch(upstreamUrl, requestInit);
    const tx = extractTxSignature(response);

    if (response.status === 402) {
      const responseBody = await response.text();
      logger.error(`mpp: payment failed, raw response: ${responseBody}`);
      appendHistory(historyPath, {
        t: Date.now(),
        ok: false,
        kind: "x402_inference",
        net: TEMPO_NETWORK,
        from: walletAddress,
        ms: Date.now() - startMs,
        error: "payment_required",
      });
      writeErrorResponse(
        res,
        402,
        `MPP payment failed: ${responseBody.substring(0, 200) || "unknown error"}. Wallet: ${walletAddress}`,
        "mpp_payment_error",
        "payment_failed",
        isMessagesApi,
      );
      return true;
    }

    const resHeaders: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) {
      resHeaders[key] = value;
    }
    res.writeHead(response.status, resHeaders);
    const responseBody = await response.text();
    res.end(responseBody);

    const usageTracker = createSseTracker();
    usageTracker.pushJson(responseBody);
    const payment = mpp.shiftPayment();
    appendInferenceHistory({
      historyPath,
      allModels,
      walletAddress,
      paymentNetwork: payment?.network ?? TEMPO_NETWORK,
      paymentTo: undefined,
      tx: tx ?? payment?.receipt?.reference,
      amount: parseMppAmount(payment?.amount),
      thinkingMode,
      usage: usageTracker.result,
      durationMs: Date.now() - startMs,
    });
    return true;
  } catch (err) {
    dbg(`mpp error: ${String(err)}`);
    logger.error(`mpp: fetch threw: ${String(err)}`);
    appendHistory(historyPath, {
      t: Date.now(),
      ok: false,
      kind: "x402_inference",
      net: TEMPO_NETWORK,
      from: walletAddress,
      ms: Date.now() - startMs,
      error: String(err).substring(0, 200),
    });
    if (!res.headersSent) {
      writeErrorResponse(
        res,
        402,
        `MPP request failed: ${String(err)}`,
        "mpp_payment_error",
        "payment_failed",
        isMessagesApi,
      );
    } else if (!res.writableEnded) {
      res.end();
    }
    return true;
  }
}

type AppendInferenceHistoryOptions = {
  historyPath: string;
  allModels: Pick<ModelEntry, "provider" | "id">[];
  walletAddress: string;
  paymentNetwork: string;
  paymentTo?: string;
  tx?: string;
  amount?: number;
  thinkingMode?: string;
  usage: InferenceUsage | undefined;
  durationMs: number;
};

function appendInferenceHistory(opts: AppendInferenceHistoryOptions): void {
  const {
    historyPath,
    allModels,
    walletAddress,
    paymentNetwork,
    paymentTo,
    tx,
    amount,
    thinkingMode,
    usage,
    durationMs,
  } = opts;

  if (usage) {
    appendHistory(historyPath, {
      t: Date.now(),
      ok: true,
      kind: "x402_inference",
      net: paymentNetwork,
      from: walletAddress,
      to: paymentTo,
      tx,
      amount,
      token: "USDC",
      provider: allModels.find(
        (entry) => entry.id === usage.model || `${entry.provider}/${entry.id}` === usage.model,
      )?.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      thinking: thinkingMode,
      ms: durationMs,
    });
  } else {
    appendHistory(historyPath, {
      t: Date.now(),
      ok: true,
      kind: "x402_inference",
      net: paymentNetwork,
      from: walletAddress,
      to: paymentTo,
      tx,
      amount,
      token: "USDC",
      ms: durationMs,
    });
  }
}
