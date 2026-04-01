import type { x402Client } from "@x402/fetch";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";

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

// --- MPP handler ---

/**
 * Create an MPP proxy handler using mppx client.
 * Dynamically imports mppx/client to keep startup fast.
 */
export async function createMppProxyHandler(opts: {
  evmKey: string;
  maxDeposit?: string;
}): Promise<MppProxyHandler> {
  const { Mppx, tempo } = await import("mppx/client");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { saveSession, clearSession } = await import("./lib/config.js");

  const account = privateKeyToAccount(opts.evmKey as `0x${string}`);
  const maxDeposit = opts.maxDeposit ?? "1";
  const paymentQueue: MppPaymentInfo[] = [];
  let lastChallengeAmount: string | undefined;

  const debug = process.env.X402_PROXY_DEBUG === "1";

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

  // Lazy session creation - only needed for SSE streaming
  let session: ReturnType<typeof tempo.session> | undefined;
  let persistedChannelId: string | undefined;

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
      session ??= tempo.session({ account, maxDeposit });
      const url = typeof input === "string" ? input : input.toString();
      const iterable = await session.sse(
        url,
        injectPayerHeader(init) as Parameters<typeof session.sse>[1],
      );

      // Persist channelId for tracking. The server includes channelId in 402
      // challenges for returning payers, so mppx auto-recovers on restart
      // via tryRecoverChannel() without any client-side injection.
      if (session.channelId && session.channelId !== persistedChannelId) {
        persistedChannelId = session.channelId;
        if (debug) process.stderr.write(`[x402-proxy] channelId: ${persistedChannelId}\n`);
        try {
          saveSession({ channelId: session.channelId, createdAt: new Date().toISOString() });
        } catch {
          // Non-critical
        }
      }

      paymentQueue.push({ protocol: "mpp", network: TEMPO_NETWORK, intent: "session" });
      return iterable;
    },

    shiftPayment: () => paymentQueue.shift(),

    async close(): Promise<void> {
      if (session?.opened) {
        const receipt = await session.close();
        try {
          clearSession();
        } catch {
          // Non-critical
        }
        if (receipt) {
          // spent is in USDC base units (6 decimals)
          const spentUsdc = receipt.spent
            ? (Number(receipt.spent) / 1_000_000).toString()
            : undefined;
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
      }
    },
  };
}
