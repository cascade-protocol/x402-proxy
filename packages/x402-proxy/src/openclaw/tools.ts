import { Type } from "@sinclair/typebox";
import type { KeyPairSigner } from "@solana/kit";
import { extractTxSignature, type PaymentInfo, type X402ProxyHandler } from "../handler.js";
import { appendHistory, calcSpend, formatAmount, readHistory } from "../history.js";
import { getSolBalance, getTokenAccounts, getUsdcBalance } from "./solana.js";

export const SOL_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC_DECIMALS = 6;
const INFERENCE_RESERVE = 0.3;
const MAX_RESPONSE_CHARS = 50_000;

export function paymentAmount(payment: PaymentInfo | undefined): number | undefined {
  if (!payment?.amount) return undefined;
  const parsed = Number.parseFloat(payment.amount);
  return Number.isNaN(parsed) ? undefined : parsed / 10 ** USDC_DECIMALS;
}

export type ModelEntry = {
  provider: string;
  id: string;
  name: string;
  maxTokens: number;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
};

export type ToolContext = {
  getWalletAddress: () => string | null;
  getSigner: () => KeyPairSigner | null;
  rpcUrl: string;
  historyPath: string;
  proxy: X402ProxyHandler;
  allModels: ModelEntry[];
};

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export async function getWalletSnapshot(rpcUrl: string, wallet: string, historyPath: string) {
  const [{ ui, raw }, sol, tokens] = await Promise.all([
    getUsdcBalance(rpcUrl, wallet),
    getSolBalance(rpcUrl, wallet),
    getTokenAccounts(rpcUrl, wallet).catch(() => []),
  ]);
  const records = readHistory(historyPath);
  const spend = calcSpend(records);
  return { ui, raw, sol, tokens, records, spend };
}

export function createBalanceTool(ctx: ToolContext) {
  return {
    name: "x_balance",
    label: "Wallet Balance",
    description:
      "Check wallet SOL and USDC balances. Use before making payments to verify sufficient funds.",
    parameters: Type.Object({}),
    async execute() {
      const walletAddress = ctx.getWalletAddress();
      if (!walletAddress) {
        return toolResult("Wallet not loaded yet. Wait for gateway startup.");
      }
      try {
        const snap = await getWalletSnapshot(ctx.rpcUrl, walletAddress, ctx.historyPath);
        const total = Number.parseFloat(snap.ui);
        const available = Math.max(0, total - INFERENCE_RESERVE);
        const tokenLines = snap.tokens.slice(0, 5).map((t) => {
          const short = `${t.mint.slice(0, 4)}...${t.mint.slice(-4)}`;
          return `${Number.parseFloat(t.amount).toLocaleString("en-US", { maximumFractionDigits: 0 })} (${short})`;
        });
        return toolResult(
          [
            `Wallet: ${walletAddress}`,
            `SOL: ${snap.sol} SOL`,
            `USDC: ${snap.ui} USDC`,
            `Available for tools: ${available.toFixed(2)} USDC`,
            `Reserved for inference: ${INFERENCE_RESERVE.toFixed(2)} USDC`,
            `Spent today: ${formatAmount(snap.spend.today, "USDC")}`,
            `Total spent: ${formatAmount(snap.spend.total, "USDC")} (${snap.spend.count} txs)`,
            ...(tokenLines.length > 0 ? [`Tokens held: ${tokenLines.join(", ")}`] : []),
          ].join("\n"),
        );
      } catch (err) {
        return toolResult(`Failed to check balance: ${String(err)}`);
      }
    },
  };
}

export function createPaymentTool(ctx: ToolContext) {
  return {
    name: "x_payment",
    label: "x402 Payment",
    description:
      "Call an x402-enabled paid API endpoint with automatic USDC payment on Solana. " +
      "Use this when you need to call a paid service given by the user. " +
      `Note: ${INFERENCE_RESERVE.toFixed(2)} USDC is reserved for LLM inference and cannot be spent by this tool.`,
    parameters: Type.Object({
      url: Type.String({ description: "The x402-enabled endpoint URL" }),
      method: Type.Optional(Type.String({ description: "HTTP method (default: GET)" })),
      params: Type.Optional(
        Type.String({
          description:
            "For GET: query params as JSON object. For POST/PUT/PATCH: JSON request body.",
        }),
      ),
      headers: Type.Optional(Type.String({ description: "Custom HTTP headers as JSON object" })),
    }),
    async execute(
      _id: string,
      params: { url: string; method?: string; params?: string; headers?: string },
    ) {
      const walletAddress = ctx.getWalletAddress();
      if (!walletAddress) {
        return toolResult("Wallet not loaded yet. Wait for gateway startup.");
      }

      try {
        const { ui } = await getUsdcBalance(ctx.rpcUrl, walletAddress);
        if (Number.parseFloat(ui) <= INFERENCE_RESERVE) {
          return toolResult(
            `Insufficient funds. Balance: ${ui} USDC, reserved for inference: ${INFERENCE_RESERVE.toFixed(2)} USDC. Top up wallet: ${walletAddress}`,
          );
        }
      } catch {
        // If balance check fails, proceed anyway
      }

      const method = (params.method || "GET").toUpperCase();
      let url = params.url;
      const reqInit: RequestInit = { method };

      if (params.headers) {
        try {
          reqInit.headers = JSON.parse(params.headers) as Record<string, string>;
        } catch {
          return toolResult("Invalid headers JSON.");
        }
      }

      if (params.params) {
        if (method === "GET" || method === "HEAD") {
          try {
            const qp = JSON.parse(params.params) as Record<string, string>;
            const qs = new URLSearchParams(qp).toString();
            url = qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
          } catch {
            return toolResult("Invalid params JSON for GET request.");
          }
        } else {
          reqInit.body = params.params;
          reqInit.headers = {
            "Content-Type": "application/json",
            ...(reqInit.headers as Record<string, string> | undefined),
          };
        }
      }

      const toolStartMs = Date.now();
      try {
        const response = await ctx.proxy.x402Fetch(url, reqInit);
        const body = await response.text();

        if (response.status === 402) {
          ctx.proxy.shiftPayment();
          appendHistory(ctx.historyPath, {
            t: Date.now(),
            ok: false,
            kind: "x402_payment",
            net: SOL_MAINNET,
            from: walletAddress,
            label: url,
            ms: Date.now() - toolStartMs,
            error: "payment_required",
          });
          return toolResult(
            `Payment failed (402): ${body.substring(0, 500)}. Wallet: ${walletAddress}`,
          );
        }

        const payment = ctx.proxy.shiftPayment();
        const amount = paymentAmount(payment);
        appendHistory(ctx.historyPath, {
          t: Date.now(),
          ok: true,
          kind: "x402_payment",
          net: SOL_MAINNET,
          from: walletAddress,
          to: payment?.payTo,
          tx: extractTxSignature(response),
          amount,
          token: "USDC",
          label: url,
          ms: Date.now() - toolStartMs,
        });

        const truncated =
          body.length > MAX_RESPONSE_CHARS
            ? `${body.substring(0, MAX_RESPONSE_CHARS)}\n\n[Truncated - response was ${body.length} chars]`
            : body;

        return toolResult(`HTTP ${response.status}\n\n${truncated}`);
      } catch (err) {
        ctx.proxy.shiftPayment();
        appendHistory(ctx.historyPath, {
          t: Date.now(),
          ok: false,
          kind: "x402_payment",
          net: SOL_MAINNET,
          from: walletAddress,
          label: params.url,
          error: String(err).substring(0, 200),
        });
        const msg = String(err);
        const text =
          msg.includes("Simulation failed") || msg.includes("insufficient")
            ? `Payment failed - insufficient funds. Wallet: ${walletAddress}. Error: ${msg}`
            : `Request failed: ${msg}`;
        return toolResult(text);
      }
    },
  };
}
