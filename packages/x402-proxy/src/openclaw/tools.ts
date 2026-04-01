import { Type } from "@sinclair/typebox";
import type { KeyPairSigner } from "@solana/kit";
import { fetchAllBalances } from "../commands/wallet.js";
import {
  createMppProxyHandler,
  extractTxSignature,
  type PaymentInfo,
  TEMPO_NETWORK,
  type X402ProxyHandler,
} from "../handler.js";
import { appendHistory, calcSpend, formatAmount, readHistory } from "../history.js";
import type { PaymentProtocol } from "./defaults.js";
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

export function parseMppAmount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export type ModelEntry = {
  provider: string;
  id: string;
  name: string;
  maxTokens: number;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
};

export type ToolContext = {
  ensureReady: () => Promise<void>;
  getSolanaWalletAddress: () => string | null;
  getEvmWalletAddress: () => string | null;
  getSigner: () => KeyPairSigner | null;
  getX402Proxy: () => X402ProxyHandler | null;
  getEvmKey: () => string | null;
  getDefaultRequestProtocol: () => PaymentProtocol;
  getDefaultMppSessionBudget: () => string;
  rpcUrl: string;
  historyPath: string;
  allModels: ModelEntry[];
};

function toolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export function addressForNetwork(
  evmAddress: string | null,
  solanaAddress: string | null,
  network: string | undefined,
): string | null {
  if (network?.startsWith("eip155:")) return evmAddress ?? solanaAddress;
  if (network?.startsWith("solana:")) return solanaAddress ?? evmAddress;
  return solanaAddress ?? evmAddress;
}

function walletAddressForNetwork(ctx: ToolContext, network: string | undefined): string {
  return (
    addressForNetwork(ctx.getEvmWalletAddress(), ctx.getSolanaWalletAddress(), network) ?? "unknown"
  );
}

export async function getWalletSnapshot(
  rpcUrl: string,
  solanaWallet: string | null,
  evmWallet: string | null,
  historyPath: string,
) {
  const [{ ui, raw }, sol, tokens, balances] = await Promise.all([
    solanaWallet ? getUsdcBalance(rpcUrl, solanaWallet) : Promise.resolve({ ui: "0", raw: 0n }),
    solanaWallet ? getSolBalance(rpcUrl, solanaWallet) : Promise.resolve("0"),
    solanaWallet ? getTokenAccounts(rpcUrl, solanaWallet).catch(() => []) : Promise.resolve([]),
    fetchAllBalances(evmWallet ?? undefined, solanaWallet ?? undefined),
  ]);
  const records = readHistory(historyPath);
  const spend = calcSpend(records);
  return {
    ui,
    raw,
    sol,
    tokens,
    balances,
    records,
    spend,
  };
}

export function createWalletTool(ctx: ToolContext) {
  return {
    name: "x_wallet",
    label: "Wallet Status",
    description:
      "Check wallet readiness, balances, and spend history for x402 and MPP payments before making paid requests.",
    parameters: Type.Object({}),
    async execute() {
      await ctx.ensureReady();
      const solanaWallet = ctx.getSolanaWalletAddress();
      const evmWallet = ctx.getEvmWalletAddress();
      if (!solanaWallet && !evmWallet) {
        return toolResult(
          "Wallet not configured yet. Run `x402-proxy setup` or set X402_PROXY_WALLET_MNEMONIC.",
        );
      }

      try {
        const snap = await getWalletSnapshot(ctx.rpcUrl, solanaWallet, evmWallet, ctx.historyPath);
        const total = Number.parseFloat(snap.ui);
        const available = Math.max(0, total - INFERENCE_RESERVE);
        const tokenLines = snap.tokens.slice(0, 5).map((t) => {
          const short = `${t.mint.slice(0, 4)}...${t.mint.slice(-4)}`;
          return `${Number.parseFloat(t.amount).toLocaleString("en-US", { maximumFractionDigits: 0 })} (${short})`;
        });
        const lines = [
          `Default protocol: ${ctx.getDefaultRequestProtocol()}`,
          `MPP budget: ${ctx.getDefaultMppSessionBudget()} USDC`,
          `MPP ready: ${evmWallet ? "yes" : "no"}`,
          `x402 ready: ${solanaWallet ? "yes" : "no"}`,
        ];
        if (evmWallet) {
          lines.push(`Base wallet: ${evmWallet}`);
          lines.push(`Base balance: ${snap.balances.evm?.usdc ?? "?"} USDC`);
          lines.push(`Tempo balance: ${snap.balances.tempo?.usdc ?? "?"} USDC`);
        }
        if (solanaWallet) {
          lines.push(`Solana wallet: ${solanaWallet}`);
          lines.push(`Solana: ${snap.sol} SOL`);
          lines.push(`Solana USDC: ${snap.ui} USDC`);
          lines.push(`Available for x402 tools: ${available.toFixed(2)} USDC`);
          lines.push(`Reserved for inference: ${INFERENCE_RESERVE.toFixed(2)} USDC`);
        }
        lines.push(`Spent today: ${formatAmount(snap.spend.today, "USDC")}`);
        lines.push(
          `Total spent: ${formatAmount(snap.spend.total, "USDC")} (${snap.spend.count} txs)`,
        );
        if (tokenLines.length > 0) {
          lines.push(`Tokens held: ${tokenLines.join(", ")}`);
        }
        if (!evmWallet) {
          lines.push(
            "MPP setup hint: set X402_PROXY_WALLET_MNEMONIC or X402_PROXY_WALLET_EVM_KEY, or run x402-proxy setup.",
          );
        }
        if (!solanaWallet) {
          lines.push(
            "x402 setup hint: add a Solana wallet or mnemonic if you want to pay Solana x402 endpoints.",
          );
        }
        return toolResult(lines.join("\n"));
      } catch (err) {
        return toolResult(`Failed to check wallet status: ${String(err)}`);
      }
    },
  };
}

export function createRequestTool(ctx: ToolContext) {
  return {
    name: "x_request",
    label: "Paid Request",
    description:
      "Call a paid HTTP endpoint with automatic x402 or MPP settlement. Defaults to the plugin protocol and supports explicit protocol override.",
    parameters: Type.Object({
      url: Type.String({ description: "The paid endpoint URL" }),
      method: Type.Optional(Type.String({ description: "HTTP method (default: GET)" })),
      params: Type.Optional(
        Type.String({
          description:
            "For GET: query params as JSON object. For POST/PUT/PATCH: JSON request body.",
        }),
      ),
      headers: Type.Optional(Type.String({ description: "Custom HTTP headers as JSON object" })),
      protocol: Type.Optional(
        Type.Union([Type.Literal("x402"), Type.Literal("mpp"), Type.Literal("auto")], {
          description: "Override the default payment protocol for this request.",
        }),
      ),
    }),
    async execute(
      _id: string,
      params: {
        url: string;
        method?: string;
        params?: string;
        headers?: string;
        protocol?: PaymentProtocol;
      },
    ) {
      await ctx.ensureReady();

      const solanaWallet = ctx.getSolanaWalletAddress();
      const evmWallet = ctx.getEvmWalletAddress();
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

      const protocol =
        params.protocol && ["x402", "mpp", "auto"].includes(params.protocol)
          ? params.protocol
          : ctx.getDefaultRequestProtocol();
      const toolStartMs = Date.now();

      if ((protocol === "mpp" || protocol === "auto") && !ctx.getEvmKey()) {
        return toolResult(
          "MPP request failed: no EVM wallet configured. Run x402-proxy setup or set X402_PROXY_WALLET_EVM_KEY.",
        );
      }

      if (protocol === "x402") {
        if (!solanaWallet) {
          return toolResult(
            "x402 request failed: no Solana wallet configured. Add a mnemonic or Solana key first.",
          );
        }
        try {
          const { ui } = await getUsdcBalance(ctx.rpcUrl, solanaWallet);
          if (Number.parseFloat(ui) <= INFERENCE_RESERVE) {
            return toolResult(
              `Insufficient funds. Balance: ${ui} USDC, reserved for inference: ${INFERENCE_RESERVE.toFixed(2)} USDC. Top up wallet: ${solanaWallet}`,
            );
          }
        } catch {
          // best effort only
        }

        const proxy = ctx.getX402Proxy();
        if (!proxy) {
          return toolResult("x402 wallet is not ready yet. Try again in a moment.");
        }

        try {
          const response = await proxy.x402Fetch(url, reqInit);
          const body = await response.text();

          if (response.status === 402) {
            const payment = proxy.shiftPayment();
            appendHistory(ctx.historyPath, {
              t: Date.now(),
              ok: false,
              kind: "x402_payment",
              net: payment?.network ?? SOL_MAINNET,
              from: walletAddressForNetwork(ctx, payment?.network),
              label: url,
              ms: Date.now() - toolStartMs,
              error: "payment_required",
            });
            return toolResult(
              `Payment failed (402): ${body.substring(0, 500)}. Wallet: ${walletAddressForNetwork(ctx, payment?.network)}`,
            );
          }

          const payment = proxy.shiftPayment();
          const amount = paymentAmount(payment);
          appendHistory(ctx.historyPath, {
            t: Date.now(),
            ok: true,
            kind: "x402_payment",
            net: payment?.network ?? SOL_MAINNET,
            from: walletAddressForNetwork(ctx, payment?.network),
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
          ctx.getX402Proxy()?.shiftPayment();
          appendHistory(ctx.historyPath, {
            t: Date.now(),
            ok: false,
            kind: "x402_payment",
            net: SOL_MAINNET,
            from: solanaWallet,
            label: params.url,
            error: String(err).substring(0, 200),
          });
          const msg = String(err);
          const text =
            msg.includes("Simulation failed") || msg.includes("insufficient")
              ? `Payment failed - insufficient funds. Wallet: ${solanaWallet}. Error: ${msg}`
              : `Request failed: ${msg}`;
          return toolResult(text);
        }
      }

      const evmKey = ctx.getEvmKey();
      if (!evmKey) {
        return toolResult(
          "MPP request failed: no EVM wallet configured. Run x402-proxy setup or set X402_PROXY_WALLET_EVM_KEY.",
        );
      }
      const mpp = await createMppProxyHandler({
        evmKey,
        maxDeposit: ctx.getDefaultMppSessionBudget(),
      });

      try {
        const response = await mpp.fetch(url, reqInit);
        const body = await response.text();
        const payment = mpp.shiftPayment();

        if (response.status === 402) {
          appendHistory(ctx.historyPath, {
            t: Date.now(),
            ok: false,
            kind: "mpp_payment",
            net: payment?.network ?? TEMPO_NETWORK,
            from: evmWallet ?? "unknown",
            label: url,
            ms: Date.now() - toolStartMs,
            error: "payment_required",
          });
          return toolResult(`MPP payment failed (402): ${body.substring(0, 500)}`);
        }

        appendHistory(ctx.historyPath, {
          t: Date.now(),
          ok: true,
          kind: "mpp_payment",
          net: payment?.network ?? TEMPO_NETWORK,
          from: evmWallet ?? "unknown",
          tx: extractTxSignature(response) ?? payment?.receipt?.reference,
          amount: parseMppAmount(payment?.amount),
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
        appendHistory(ctx.historyPath, {
          t: Date.now(),
          ok: false,
          kind: "mpp_payment",
          net: TEMPO_NETWORK,
          from: evmWallet ?? "unknown",
          label: params.url,
          error: String(err).substring(0, 200),
        });
        return toolResult(`MPP request failed: ${String(err)}`);
      } finally {
        await mpp.close().catch(() => {});
      }
    },
  };
}
