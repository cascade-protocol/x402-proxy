import type { IncomingMessage, ServerResponse } from "node:http";
import type { MppProxyHandler, X402ProxyHandler } from "../handler.js";
import { createMppProxyHandler, extractTxSignature, TEMPO_NETWORK } from "../handler.js";
import { appendHistory } from "../history.js";
import type { ResolvedProviderConfig } from "./defaults.js";
import { type ModelEntry, parseMppAmount, paymentAmount, SOL_MAINNET } from "./tools.js";

export type InferenceProxyRouteOptions = {
  providers: ResolvedProviderConfig[];
  getX402Proxy: () => X402ProxyHandler | null;
  getWalletAddress: () => string | null;
  getWalletAddressForNetwork?: (network: string) => string | null;
  getEvmKey: () => string | null;
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
    getWalletAddress,
    getWalletAddressForNetwork,
    getEvmKey,
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

    const method = req.method ?? "GET";
    const startMs = Date.now();

    try {
      const requestInit: RequestInit = {
        method,
        headers,
        body: ["GET", "HEAD"].includes(method) ? undefined : body,
      };
      const useMpp = provider.protocol === "mpp" || provider.protocol === "auto";
      const wantsStreaming = isChatCompletion && /"stream"\s*:\s*true/.test(body);

      if (useMpp) {
        const evmKey = getEvmKey();
        if (!evmKey) {
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
        return await handleMppRequest({
          req,
          res,
          upstreamUrl,
          requestInit,
          walletAddress,
          historyPath,
          logger,
          allModels,
          thinkingMode,
          wantsStreaming,
          startMs,
          evmKey,
          mppSessionBudget: provider.mppSessionBudget,
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

        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: userMessage, type: "x402_payment_error", code: "payment_failed" },
          }),
        );
        return true;
      }

      if (!response.ok && isChatCompletion) {
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

        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: `LLM provider temporarily unavailable (HTTP ${response.status}). Try again shortly.`,
              type: "x402_upstream_error",
              code: "upstream_failed",
            },
          }),
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
      const isSSE = isChatCompletion && ct.includes("text/event-stream");
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

      const durationMs = Date.now() - startMs;
      if (sse?.lastData) {
        try {
          const parsed = JSON.parse(sse.lastData) as {
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
          const usage = parsed.usage;
          const model = parsed.model ?? "";
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
            provider: allModels.find((m) => m.id === model || `${m.provider}/${m.id}` === model)
              ?.provider,
            model,
            inputTokens: usage?.prompt_tokens ?? 0,
            outputTokens: usage?.completion_tokens ?? 0,
            reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
            cacheRead: usage?.prompt_tokens_details?.cached_tokens,
            cacheWrite: usage?.prompt_tokens_details?.cache_creation_input_tokens,
            thinking: thinkingMode,
            ms: durationMs,
          });
        } catch {
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
            ms: durationMs,
          });
        }
      } else {
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
          ms: durationMs,
        });
      }
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
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: userMessage, type: "x402_payment_error", code: "payment_failed" },
          }),
        );
      }
      return true;
    }
  };
}

function createSseTracker() {
  let residual = "";
  let lastDataLine = "";
  return {
    push(text: string) {
      const combined = residual + text;
      const lines = combined.split("\n");
      residual = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          lastDataLine = line.slice(6);
        }
      }
    },
    get lastData() {
      return lastDataLine;
    },
  };
}

type HandleMppRequestOptions = {
  req: IncomingMessage;
  res: ServerResponse;
  upstreamUrl: string;
  requestInit: RequestInit;
  walletAddress: string;
  historyPath: string;
  logger: { info: (msg: string) => void; error: (msg: string) => void };
  allModels: Pick<ModelEntry, "provider" | "id">[];
  thinkingMode?: string;
  wantsStreaming: boolean;
  startMs: number;
  evmKey: string;
  mppSessionBudget: string;
};

async function closeMppSession(handler: MppProxyHandler): Promise<void> {
  try {
    await handler.close();
  } catch {
    // best effort: request already completed
  }
}

export async function handleMppRequest(opts: HandleMppRequestOptions): Promise<boolean> {
  const {
    req,
    res,
    upstreamUrl,
    requestInit,
    walletAddress,
    historyPath,
    logger,
    allModels,
    thinkingMode,
    wantsStreaming,
    startMs,
    evmKey,
    mppSessionBudget,
  } = opts;

  const mpp = await createMppProxyHandler({ evmKey, maxDeposit: mppSessionBudget });

  try {
    if (wantsStreaming) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      const sse = createSseTracker();
      const stream = await mpp.sse(upstreamUrl, requestInit);
      for await (const chunk of stream) {
        const text = String(chunk);
        res.write(text);
        sse.push(text);
      }

      res.end();
      mpp.shiftPayment(); // skip session-open marker pushed by sse()
      const payment = mpp.shiftPayment(); // get the close receipt
      appendInferenceHistory({
        historyPath,
        allModels,
        walletAddress,
        paymentNetwork: payment?.network ?? TEMPO_NETWORK,
        paymentTo: undefined,
        tx: payment?.receipt?.reference ?? payment?.channelId,
        amount: parseMppAmount(payment?.amount),
        thinkingMode,
        lastDataLine: sse.lastData,
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
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `MPP payment failed: ${responseBody.substring(0, 200) || "unknown error"}. Wallet: ${walletAddress}`,
            type: "mpp_payment_error",
            code: "payment_failed",
          },
        }),
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
      lastDataLine: responseBody,
      durationMs: Date.now() - startMs,
    });
    return true;
  } catch (err) {
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
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: `MPP request failed: ${String(err)}`,
            type: "mpp_payment_error",
            code: "payment_failed",
          },
        }),
      );
    }
    return true;
  } finally {
    await closeMppSession(mpp);
    if (!res.writableEnded) {
      res.end();
    }
    req.resume();
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
  lastDataLine: string;
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
    lastDataLine,
    durationMs,
  } = opts;

  try {
    const parsed = JSON.parse(lastDataLine) as {
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
    const usage = parsed.usage;
    const model = parsed.model ?? "";
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
        (entry) => entry.id === model || `${entry.provider}/${entry.id}` === model,
      )?.provider,
      model,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
      cacheRead: usage?.prompt_tokens_details?.cached_tokens,
      cacheWrite: usage?.prompt_tokens_details?.cache_creation_input_tokens,
      thinking: thinkingMode,
      ms: durationMs,
    });
  } catch {
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
