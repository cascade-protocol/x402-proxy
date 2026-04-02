import type { x402Client } from "@x402/fetch";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { Mppx, tempo } from "mppx/client";
import { Session } from "mppx/tempo";
import { parseUnits } from "viem";
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

// --- MPP handler ---

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
      const req = challenge.request as { amount?: string; decimals?: number };
      if (req.amount) {
        lastChallengeAmount = (Number(req.amount) / 10 ** (req.decimals ?? 6)).toString();
      }
      return undefined;
    },
  });

  const payerAddress = account.address;

  function injectPayerHeader(init?: RequestInit): RequestInit {
    const existing =
      init?.headers instanceof Headers
        ? Object.fromEntries(init.headers.entries())
        : ((init?.headers as Record<string, string> | undefined) ?? {});
    return { ...init, headers: { ...existing, "X-Payer-Address": payerAddress } };
  }

  type SessionReceipt = {
    method: string;
    reference: string;
    status: string;
    timestamp: string;
    acceptedCumulative?: string;
    txHash?: string;
    spent: string;
  };
  type ActiveSession = {
    channelId?: string;
    cumulative: bigint;
    opened: boolean;
    close: () => Promise<SessionReceipt | undefined>;
  };
  type CreateCredentialFn = (context?: Record<string, unknown>) => Promise<string>;
  type ChannelEntry = {
    channelId: string;
    cumulativeAmount: bigint;
    opened: boolean;
  };

  const activeSessions = new Set<ActiveSession>();
  let persistedChannelId: string | undefined;

  function rememberSession(session: ActiveSession): void {
    activeSessions.add(session);
    if (session.channelId && session.channelId !== persistedChannelId) {
      persistedChannelId = session.channelId;
      if (debug) process.stderr.write(`[x402-proxy] channelId: ${persistedChannelId}\n`);
      try {
        saveSession({ channelId: session.channelId, createdAt: new Date().toISOString() });
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
      channelId: session.channelId ?? undefined,
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
      const response = await mppx.fetch(
        typeof input === "string" ? input : input.toString(),
        injectPayerHeader(init),
      );

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
      let createCredential: CreateCredentialFn | undefined;
      let spent = 0n;
      const session: ActiveSession = {
        channelId: undefined,
        cumulative: 0n,
        opened: false,
        async close() {
          if (!session.opened || !session.channelId || !createCredential) return undefined;

          const credential = await createCredential({
            action: "close",
            channelId: session.channelId,
            cumulativeAmountRaw: spent.toString(),
          });
          const response = await mppx.rawFetch(url, {
            method: "POST",
            headers: { Authorization: credential, "X-Payer-Address": payerAddress },
          });
          const receiptHeader = response.headers.get("Payment-Receipt");
          if (!receiptHeader) return undefined;
          try {
            const receipt = Session.Receipt.deserializeSessionReceipt(receiptHeader);
            spent = spent > BigInt(receipt.spent) ? spent : BigInt(receipt.spent);
            return receipt;
          } catch {
            return undefined;
          }
        },
      };

      const sessionMppx = Mppx.create({
        methods: [
          tempo({
            account,
            maxDeposit,
            onChannelUpdate(entry: ChannelEntry) {
              session.channelId = entry.channelId;
              session.cumulative = entry.cumulativeAmount;
              session.opened = entry.opened;
              if (entry.channelId && entry.channelId !== persistedChannelId) {
                persistedChannelId = entry.channelId;
                if (debug) process.stderr.write(`[x402-proxy] channelId: ${persistedChannelId}\n`);
                try {
                  saveSession({ channelId: entry.channelId, createdAt: new Date().toISOString() });
                } catch {
                  // Non-critical
                }
              }
            },
          }),
        ],
        polyfill: false,
        onChallenge: async (challenge, helpers) => {
          const req = challenge.request as { amount?: string; decimals?: number };
          if (req.amount) {
            lastChallengeAmount = (Number(req.amount) / 10 ** (req.decimals ?? 6)).toString();
          }
          createCredential = helpers.createCredential as CreateCredentialFn;
          return undefined;
        },
      });

      const response = await sessionMppx.fetch(
        url,
        injectPayerHeader({
          ...init,
          headers: {
            ...((init?.headers instanceof Headers
              ? Object.fromEntries(init.headers.entries())
              : ((init?.headers as Record<string, string> | undefined) ?? {})) as Record<
              string,
              string
            >),
            Accept: "text/event-stream",
          },
        }),
      );

      if (!response.body) throw new Error("MPP SSE response has no body");
      rememberSession(session);
      paymentQueue.push({ protocol: "mpp", network: TEMPO_NETWORK, intent: "session" });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      async function* iterate(): AsyncGenerator<string> {
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";

            for (const part of parts) {
              if (!part.trim()) continue;

              const event = Session.Sse.parseEvent(part) as
                | { type: "message"; data: string }
                | {
                    type: "payment-need-voucher";
                    data: { channelId: string; requiredCumulative: string; deposit: string };
                  }
                | { type: "payment-receipt"; data: SessionReceipt }
                | null;
              if (!event) continue;

              switch (event.type) {
                case "message":
                  yield event.data;
                  break;
                case "payment-receipt":
                  spent = spent > BigInt(event.data.spent) ? spent : BigInt(event.data.spent);
                  break;
                case "payment-need-voucher": {
                  if (!createCredential) {
                    throw new Error("MPP voucher requested before challenge helper was captured");
                  }

                  const requiredCumulative = BigInt(event.data.requiredCumulative);
                  const deposit = BigInt(event.data.deposit);
                  const target = computeMppVoucherTarget({
                    requiredCumulative,
                    deposit,
                    headroom: voucherHeadroomRaw,
                  });
                  const credential = await createCredential({
                    action: "voucher",
                    channelId: event.data.channelId,
                    cumulativeAmountRaw: target.toString(),
                  });
                  const voucherResponse = await sessionMppx.rawFetch(url, {
                    method: "POST",
                    headers: { Authorization: credential, "X-Payer-Address": payerAddress },
                    signal: init?.signal,
                  });
                  if (!voucherResponse.ok) {
                    const body = await voucherResponse.text().catch(() => "");
                    throw new Error(
                      `Voucher POST failed with status ${voucherResponse.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
                    );
                  }
                  const receiptHeader = voucherResponse.headers.get("Payment-Receipt");
                  if (receiptHeader) {
                    try {
                      const receipt = Session.Receipt.deserializeSessionReceipt(receiptHeader);
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
          reader.releaseLock();
        }
      }

      return iterate();
    },

    shiftPayment: () => paymentQueue.shift(),

    async close(): Promise<void> {
      const sessions = Array.from(activeSessions);
      if (sessions.length === 0) return;

      const byChannelId = new Map<string, ActiveSession>();
      const sessionsWithoutChannel: ActiveSession[] = [];

      for (const session of sessions) {
        if (!session.opened) continue;
        if (!session.channelId) {
          sessionsWithoutChannel.push(session);
          continue;
        }
        const existing = byChannelId.get(session.channelId);
        if (!existing || session.cumulative > existing.cumulative) {
          byChannelId.set(session.channelId, session);
        }
      }

      for (const session of sessions) activeSessions.delete(session);

      const sessionsToClose = [...byChannelId.values(), ...sessionsWithoutChannel];
      let shouldClearPersistedSession = false;
      for (const session of sessionsToClose) {
        const receipt = await session.close();
        if (session.channelId && session.channelId === persistedChannelId) {
          shouldClearPersistedSession = true;
        }
        pushCloseReceipt(session, receipt);
      }

      if (shouldClearPersistedSession) {
        try {
          clearSession();
        } catch {
          // Non-critical
        }
      }
    },
  };
}
