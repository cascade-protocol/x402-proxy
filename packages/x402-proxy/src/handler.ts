import type { x402Client } from "@x402/fetch";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { Mppx, tempo } from "mppx/client";
import { Session } from "mppx/tempo";
import { formatUnits, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { clearSession, saveSession } from "./lib/config.js";
import { getMppVoucherHeadroomUsdc, isDebugEnabled } from "./lib/env.js";

export type PaymentInfo = {
  protocol: "x402";
  network: string | undefined;
  payTo: string | undefined;
  /** Raw amount in base units as returned by x402 (e.g. "50000" for 0.05 USDC) */
  amount: string | undefined;
  asset: string | undefined;
};

export type MppPaymentInfo = {
  protocol: "mpp";
  network: string;
  amount?: string;
  intent?: string;
  channelId?: string;
  receipt?: {
    method: string;
    reference: string;
    status: string;
    timestamp: string;
    acceptedCumulative?: string;
    txHash?: string;
  };
};

export type X402ProxyOptions = {
  client: x402Client;
};

export type X402ProxyHandler = {
  /** Wrapped fetch with x402 payment handling */
  x402Fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Shift the latest payment info from the queue (call after x402Fetch) */
  shiftPayment: () => PaymentInfo | undefined;
};

export type MppProxyHandler = {
  /** Payment-aware fetch that handles 402 + WWW-Authenticate automatically */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** SSE streaming with mid-stream voucher cycling */
  sse: (input: string | URL, init?: RequestInit) => Promise<AsyncIterable<string>>;
  /** Shift the latest payment info from the queue */
  shiftPayment: () => MppPaymentInfo | undefined;
  /** Settle any active session channel */
  close: () => Promise<void>;
};

// --- Protocol detection ---

export type DetectedProtocols = { x402: boolean; mpp: boolean };

/**
 * Detect which payment protocols a 402 response advertises.
 * - x402: PAYMENT-REQUIRED or X-PAYMENT-REQUIRED header
 * - MPP: WWW-Authenticate header with Payment scheme
 */
export function detectProtocols(response: Response): DetectedProtocols {
  const pr = response.headers.get("PAYMENT-REQUIRED") ?? response.headers.get("X-PAYMENT-REQUIRED");
  const wwwAuth = response.headers.get("WWW-Authenticate");
  return {
    x402: !!pr,
    mpp: !!(wwwAuth && /^Payment\b/i.test(wwwAuth.trim())),
  };
}

// --- x402 handler ---

/**
 * Extract the on-chain transaction signature from an x402 payment response header.
 */
export function extractTxSignature(response: Response): string | undefined {
  // x402 header
  const x402Header =
    response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  if (x402Header) {
    try {
      const decoded = decodePaymentResponseHeader(x402Header);
      return (decoded as { transaction?: string }).transaction ?? undefined;
    } catch {
      // fall through
    }
  }
  // MPP Payment-Receipt header
  const mppHeader = response.headers.get("Payment-Receipt");
  if (mppHeader) {
    try {
      const decoded = JSON.parse(Buffer.from(mppHeader, "base64url").toString()) as {
        reference?: string;
      };
      return decoded.reference ?? undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Create an x402 proxy handler that wraps fetch with automatic payment.
 */
export function createX402ProxyHandler(opts: X402ProxyOptions): X402ProxyHandler {
  const { client } = opts;

  const paymentQueue: PaymentInfo[] = [];

  client.onAfterPaymentCreation(async (hookCtx) => {
    const raw = hookCtx.selectedRequirements.amount;
    paymentQueue.push({
      protocol: "x402",
      network: hookCtx.selectedRequirements.network,
      payTo: hookCtx.selectedRequirements.payTo,
      amount: raw,
      asset: hookCtx.selectedRequirements.asset,
    });
  });

  const x402Fetch = wrapFetchWithPayment(globalThis.fetch, client);

  return {
    x402Fetch,
    shiftPayment: () => paymentQueue.shift(),
  };
}

export const TEMPO_NETWORK = "eip155:4217";

const MPP_VOUCHER_HEADROOM_USDC_DEFAULT = "0.005";

export function computeMppVoucherTarget(params: {
  requiredCumulative: bigint;
  deposit: bigint;
  headroom: bigint;
}): bigint {
  const { requiredCumulative, deposit, headroom } = params;
  if (deposit <= requiredCumulative) return requiredCumulative;
  if (headroom <= 0n) return requiredCumulative;
  const target = requiredCumulative + headroom;
  return target > deposit ? deposit : target;
}

function parseVoucherHeadroom(value: string | undefined): bigint {
  const configured = value?.trim() || MPP_VOUCHER_HEADROOM_USDC_DEFAULT;
  try {
    const parsed = parseUnits(configured, 6);
    return parsed > 0n ? parsed : 0n;
  } catch {
    return parseUnits(MPP_VOUCHER_HEADROOM_USDC_DEFAULT, 6);
  }
}

// Bound to mppx's own exports rather than hand-copied: a shape change upstream
// must fail type-check here instead of surfacing as a runtime payment failure.
type SessionReceipt = ReturnType<typeof Session.Precompile.Receipt.deserializeSessionReceipt>;
type ChannelEntry = Parameters<NonNullable<tempo.Parameters["onChannelUpdate"]>>[0];
type SseEvent = NonNullable<ReturnType<typeof Session.Precompile.SseProtocol.parseEvent>>;

/**
 * Split an SSE buffer into complete frames, returning the trailing partial frame.
 * Normalizes CRLF/CR first: servers may frame with `\r\n\r\n`, which a bare
 * `\n\n` split never matches, silently stalling the stream instead of erroring.
 */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.replace(/\r\n|\r/g, "\n").split("\n\n");
  const rest = parts.pop() ?? "";
  return { frames: parts.filter((part) => part.trim()), rest };
}

const PROVIDER_ERROR_PREVIEW_BYTES = 200;
const SESSION_CLOSE_TIMEOUT_MS = 5_000;
const SESSION_EXPIRY_MARGIN_MS = 30_000;

function validForManagement(expires?: string): boolean {
  return expires === undefined || Date.parse(expires) > Date.now() + SESSION_EXPIRY_MARGIN_MS;
}

function sameHex(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
}

function matchesSessionChannel(request: Record<string, unknown>, channel: ChannelEntry): boolean {
  const details = request.methodDetails as
    | {
        chainId?: unknown;
        channelId?: unknown;
        sessionSnapshot?: { channelId?: unknown };
      }
    | undefined;
  return (
    sameHex(request.recipient, channel.descriptor.payee) &&
    sameHex(request.currency, channel.descriptor.token) &&
    (details?.chainId === undefined || details.chainId === channel.chainId) &&
    (details?.channelId === undefined || sameHex(details.channelId, channel.channelId)) &&
    (details?.sessionSnapshot === undefined ||
      sameHex(details.sessionSnapshot?.channelId, channel.channelId))
  );
}

async function responseBodyPreview(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let remaining = PROVIDER_ERROR_PREVIEW_BYTES;
  let text = "";
  try {
    while (remaining > 0) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      const prefix = value.subarray(0, remaining);
      text += decoder.decode(prefix, { stream: true });
      remaining -= prefix.byteLength;
    }
    void reader.cancel().catch(() => {});
  } catch {
    // Keep any provider detail received before the read failed.
  } finally {
    reader.releaseLock();
  }
  return text;
}

// --- MPP handler ---

export function challengeAmount(request: Record<string, unknown>): string | undefined {
  if (typeof request.amount !== "string") return undefined;
  return formatUnits(
    BigInt(request.amount),
    typeof request.decimals === "number" ? request.decimals : 6,
  );
}

/**
 * Create an MPP proxy handler using mppx client.
 */
export async function createMppProxyHandler(opts: {
  evmKey: string;
  maxDeposit?: string;
}): Promise<MppProxyHandler> {
  const account = privateKeyToAccount(opts.evmKey as `0x${string}`);
  const maxDeposit = opts.maxDeposit ?? "1";
  const voucherHeadroomRaw = parseVoucherHeadroom(getMppVoucherHeadroomUsdc());
  const paymentQueue: MppPaymentInfo[] = [];
  let lastChallengeAmount: string | undefined;

  const debug = isDebugEnabled();

  const mppx = Mppx.create({
    methods: [tempo({ account, maxDeposit })],
    polyfill: false,
    onChallenge: async (challenge) => {
      lastChallengeAmount = challengeAmount(challenge.request);
      return undefined;
    },
  });

  const payerAddress = account.address;

  function injectPayerHeader(init?: RequestInit): Headers {
    const headers = new Headers(init?.headers);
    headers.set("X-Payer-Address", payerAddress);
    return headers;
  }

  type ActiveSession = {
    channel?: ChannelEntry;
    close: (signal: AbortSignal) => Promise<SessionReceipt | undefined>;
  };

  const activeSessions = new Map<string, ActiveSession>();
  let persistedChannelId: string | undefined;

  function rememberSession(session: ActiveSession): void {
    const channel = session.channel;
    if (!channel?.opened) return;
    const previous = activeSessions.get(channel.channelId)?.channel;
    if (!previous || channel.cumulativeAmount >= previous.cumulativeAmount) {
      activeSessions.set(channel.channelId, session);
    }
  }

  function persistSession(channel?: ChannelEntry): void {
    if (channel && channel.channelId !== persistedChannelId) {
      persistedChannelId = channel.channelId;
      if (debug) process.stderr.write(`[x402-proxy] channelId: ${persistedChannelId}\n`);
      try {
        saveSession({ channelId: channel.channelId, createdAt: new Date().toISOString() });
      } catch {
        // Non-critical
      }
    }
  }

  function pushCloseReceipt(
    session: ActiveSession,
    receipt: Awaited<ReturnType<ActiveSession["close"]>>,
  ) {
    if (!receipt) return;
    const spentUsdc = receipt.spent ? (Number(receipt.spent) / 1_000_000).toString() : undefined;
    paymentQueue.push({
      protocol: "mpp",
      network: TEMPO_NETWORK,
      intent: "session",
      amount: spentUsdc,
      channelId: session.channel?.channelId,
      receipt: {
        method: receipt.method,
        reference: receipt.reference,
        status: receipt.status,
        timestamp: receipt.timestamp,
        acceptedCumulative: receipt.acceptedCumulative,
        txHash: receipt.txHash,
      },
    });
  }

  return {
    // Non-streaming uses stateless one-shot charges (not sessions) - intentional.
    // Each fetch() handles its own 402 challenge/response cycle independently.
    async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
      const response = await mppx.fetch(typeof input === "string" ? input : input.toString(), {
        ...init,
        headers: injectPayerHeader(init),
      });

      // Extract payment info from Payment-Receipt header
      const receiptHeader = response.headers.get("Payment-Receipt");
      if (receiptHeader) {
        try {
          const receipt = JSON.parse(
            Buffer.from(receiptHeader, "base64url").toString(),
          ) as MppPaymentInfo["receipt"];
          paymentQueue.push({
            protocol: "mpp",
            network: TEMPO_NETWORK,
            amount: lastChallengeAmount,
            receipt,
          });
        } catch {
          paymentQueue.push({
            protocol: "mpp",
            network: TEMPO_NETWORK,
            amount: lastChallengeAmount,
          });
        }
        lastChallengeAmount = undefined;
      }

      return response;
    },

    async sse(input: string | URL, init?: RequestInit): Promise<AsyncIterable<string>> {
      const url = typeof input === "string" ? input : input.toString();
      let spent = 0n;
      const sessionMppx = Mppx.create({
        methods: [
          tempo({
            account,
            maxDeposit,
            origin: new URL(url).origin,
            onChannelUpdate(entry) {
              session.channel = entry;
              if (activeSessions.has(entry.channelId)) rememberSession(session);
            },
          }),
        ],
        polyfill: false,
      });
      const headers = injectPayerHeader(init);
      headers.set("Accept", "text/event-stream");
      const prepared = await sessionMppx.prepareRequest(url, { ...init, headers });
      const managementUrl = prepared.request.url;
      const hostname = new URL(managementUrl).hostname.toLowerCase();
      let currentChallenge = prepared.payment?.challenge;
      let challengeResponse =
        prepared.payment && new Response(null, { status: 402, headers: prepared.response.headers });

      async function postManagement(
        action: "voucher" | "close",
        amount: bigint,
        signal?: AbortSignal | null,
      ) {
        const channel = session.channel;
        if (!channel || !currentChallenge || !challengeResponse)
          throw new Error("MPP session channel is unavailable");

        const postCredential = async (response: Response, expectedId?: string) => {
          const payment = await sessionMppx.preparePayment(response, {
            orderChallenges(offers) {
              const matching = offers.filter(
                ({ challenge }) =>
                  challenge.method === "tempo" &&
                  challenge.intent === "session" &&
                  challenge.realm.toLowerCase() === hostname &&
                  (expectedId === undefined
                    ? validForManagement(challenge.expires)
                    : challenge.id === expectedId) &&
                  matchesSessionChannel(challenge.request, channel),
              );
              if (!matching.length)
                throw new Error(
                  "No matching unexpired Tempo session challenge for this channel and host",
                );
              return matching;
            },
          });
          signal?.throwIfAborted();
          const credential = await payment.createCredential({
            action,
            channelId: channel.channelId,
            descriptor: channel.descriptor,
            cumulativeAmountRaw: amount.toString(),
          });
          signal?.throwIfAborted();
          challengeResponse = response;
          currentChallenge = payment.challenge;
          return sessionMppx.rawFetch(
            managementUrl,
            payment.setCredential(
              {
                method: "POST",
                redirect: "manual",
                signal,
                headers: { "X-Payer-Address": payerAddress },
              },
              credential,
            ),
          );
        };

        let offer = challengeResponse;
        let expectedId: string | undefined = currentChallenge.id;
        if (!validForManagement(currentChallenge.expires)) {
          const probe = await sessionMppx.rawFetch(managementUrl, {
            method: "POST",
            redirect: "manual",
            signal,
            headers: {
              "Accept-Payment": "tempo/session",
              "Payment-Session": channel.channelId,
              "X-Payer-Address": payerAddress,
            },
          });
          void probe.body?.cancel().catch(() => {});
          if (probe.status !== 402)
            throw new Error(`Expired MPP session challenge: refresh returned HTTP ${probe.status}`);
          offer = new Response(null, { status: 402, headers: probe.headers });
          expectedId = undefined;
        }

        const result = await postCredential(offer, expectedId);
        if (result.status !== 402) return result;
        void result.body?.cancel().catch(() => {});
        return postCredential(new Response(null, { status: 402, headers: result.headers }));
      }

      const session: ActiveSession = {
        async close(signal) {
          const channel = session.channel;
          if (!channel?.opened) return undefined;
          const amount = spent < channel.cumulativeAmount ? spent : channel.cumulativeAmount;
          const response = await postManagement("close", amount, signal);
          const receiptHeader = response.headers.get("Payment-Receipt");
          void response.body?.cancel().catch(() => {});
          if (!response.ok) throw new Error(`Close POST failed with status ${response.status}`);
          if (!receiptHeader) return undefined;
          try {
            return Session.Precompile.Receipt.deserializeSessionReceipt(receiptHeader);
          } catch {
            return undefined;
          }
        },
      };
      let response: Response;
      if (prepared.payment) {
        try {
          response = await prepared.payment.pay();
        } finally {
          rememberSession(session);
          void prepared.response.body?.cancel().catch(() => {});
        }
      } else {
        response = prepared.response;
      }
      if (!response.ok) {
        const body = await responseBodyPreview(response);
        throw new Error(
          `MPP SSE request failed with status ${response.status}${body ? `: ${body}` : ""}`,
        );
      }

      if (!response.body) throw new Error("MPP SSE response has no body");
      persistSession(session.channel);
      paymentQueue.push({ protocol: "mpp", network: TEMPO_NETWORK, intent: "session" });

      async function* iterate(
        body: ReadableStream<Uint8Array>,
        signal?: AbortSignal | null,
      ): AsyncGenerator<string> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let completed = false;
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              completed = true;
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const { frames, rest } = splitSseFrames(buffer);
            buffer = rest;

            for (const part of frames) {
              const event: SseEvent | null = Session.Precompile.SseProtocol.parseEvent(part);
              if (!event) continue;

              switch (event.type) {
                case "message":
                  yield event.data;
                  break;
                case "payment-receipt":
                  spent = spent > BigInt(event.data.spent) ? spent : BigInt(event.data.spent);
                  break;
                case "payment-need-voucher": {
                  const channel = session.channel;
                  if (!channel || channel.channelId !== event.data.channelId) {
                    throw new Error("MPP voucher requested for an unexpected channel");
                  }

                  const requiredCumulative = BigInt(event.data.requiredCumulative);
                  const deposit = BigInt(event.data.deposit);
                  const target = computeMppVoucherTarget({
                    requiredCumulative,
                    deposit,
                    headroom: voucherHeadroomRaw,
                  });
                  if (target > channel.deposit)
                    throw new Error(
                      `MPP voucher exceeds channel deposit: required ${requiredCumulative}, target ${target}, deposit ${channel.deposit}`,
                    );
                  const voucherResponse = await postManagement("voucher", target, signal);
                  if (!voucherResponse.ok) {
                    const body = await responseBodyPreview(voucherResponse);
                    throw new Error(
                      `Voucher POST failed with status ${voucherResponse.status}${body ? `: ${body}` : ""}`,
                    );
                  }
                  const receiptHeader = voucherResponse.headers.get("Payment-Receipt");
                  void voucherResponse.body?.cancel().catch(() => {});
                  if (receiptHeader) {
                    try {
                      const receipt =
                        Session.Precompile.Receipt.deserializeSessionReceipt(receiptHeader);
                      spent = spent > BigInt(receipt.spent) ? spent : BigInt(receipt.spent);
                    } catch {
                      // Ignore malformed receipt headers on voucher updates.
                    }
                  }
                  break;
                }
              }
            }
          }
        } finally {
          if (!completed) void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }

      return iterate(response.body, init?.signal);
    },

    shiftPayment: () => paymentQueue.shift(),

    async close(): Promise<void> {
      const sessions = [...activeSessions];
      if (!sessions.length) return;
      activeSessions.clear();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SESSION_CLOSE_TIMEOUT_MS);
      const deadline = new Promise<void>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      try {
        await Promise.race([
          deadline,
          Promise.all(
            sessions.map(async ([channelId, session]) => {
              try {
                const receipt = await session.close(controller.signal);
                if (controller.signal.aborted) return;
                pushCloseReceipt(session, receipt);
                if (channelId === persistedChannelId && !activeSessions.has(channelId)) {
                  clearSession();
                  persistedChannelId = undefined;
                }
              } catch (error) {
                if (debug)
                  process.stderr.write(
                    `[x402-proxy] close failed for ${channelId}: ${error instanceof Error ? error.message : "unknown error"}\n`,
                  );
              }
            }),
          ),
        ]);
        if (controller.signal.aborted && debug)
          process.stderr.write("[x402-proxy] session close timed out\n");
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
