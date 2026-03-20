import type { KeyPairSigner } from "@solana/kit";
import { appendHistory, formatTxLine, readHistory } from "../history.js";
import { checkAtaExists, getUsdcBalance, transferUsdc } from "./solana.js";
import { getWalletSnapshot, type ModelEntry, SOL_MAINNET } from "./tools.js";

declare const __VERSION__: string;

const HISTORY_PAGE_SIZE = 5;
const STATUS_HISTORY_COUNT = 3;
const INLINE_HISTORY_TOKEN_THRESHOLD = 3;

const TOKEN_SYMBOL_CACHE_MAX = 200;
const tokenSymbolCache = new Map<string, string>();

async function resolveTokenSymbols(mints: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const toResolve: string[] = [];

  for (const m of mints) {
    const cached = tokenSymbolCache.get(m);
    if (cached) {
      result.set(m, cached);
    } else {
      toResolve.push(m);
    }
  }

  if (toResolve.length === 0) return result;

  try {
    const res = await globalThis.fetch(
      `https://api.dexscreener.com/tokens/v1/solana/${toResolve.join(",")}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!res.ok) return result;

    const pairs = (await res.json()) as Array<{
      baseToken?: { address?: string; symbol?: string };
    }>;

    for (const pair of pairs) {
      const addr = pair.baseToken?.address;
      const sym = pair.baseToken?.symbol;
      if (addr && sym && toResolve.includes(addr)) {
        if (tokenSymbolCache.size >= TOKEN_SYMBOL_CACHE_MAX) {
          const oldest = tokenSymbolCache.keys().next();
          if (!oldest.done) tokenSymbolCache.delete(oldest.value);
        }
        tokenSymbolCache.set(addr, sym);
        result.set(addr, sym);
      }
    }
  } catch {
    // DexScreener unavailable
  }

  return result;
}

export type CommandContext = {
  getWalletAddress: () => string | null;
  getSigner: () => KeyPairSigner | null;
  rpcUrl: string;
  dashboardUrl: string;
  historyPath: string;
  allModels: Pick<ModelEntry, "provider" | "id" | "name">[];
};

async function handleSend(
  parts: string[],
  wallet: string,
  signer: KeyPairSigner | null,
  rpc: string,
  histPath: string,
): Promise<{ text: string }> {
  if (!signer) {
    return { text: "Wallet not loaded yet. Please wait for the gateway to finish starting." };
  }

  if (parts.length !== 2) {
    return {
      text: "Usage: `/x_wallet send <amount|all> <address>`\n\n  `/x_wallet send 0.5 7xKXtg...`\n  `/x_wallet send all 7xKXtg...`",
    };
  }

  const [amountStr, destAddr] = parts;
  if (destAddr.length < 32 || destAddr.length > 44) {
    return { text: `Invalid Solana address: ${destAddr}` };
  }

  try {
    const recipientHasAta = await checkAtaExists(rpc, destAddr);
    if (!recipientHasAta) {
      return {
        text: "Recipient does not have a USDC token account.\nThey need to receive USDC at least once to create one.",
      };
    }

    let amountRaw: bigint;
    let amountUi: string;
    if (amountStr.toLowerCase() === "all") {
      const balance = await getUsdcBalance(rpc, wallet);
      if (balance.raw === 0n) {
        return { text: "Wallet has no USDC to send." };
      }
      amountRaw = balance.raw;
      amountUi = balance.ui;
    } else {
      const amount = Number.parseFloat(amountStr);
      if (Number.isNaN(amount) || amount <= 0) {
        return { text: `Invalid amount: ${amountStr}` };
      }
      amountRaw = BigInt(Math.round(amount * 1e6));
      amountUi = amount.toString();
    }

    const sig = await transferUsdc(signer, rpc, destAddr, amountRaw);
    appendHistory(histPath, {
      t: Date.now(),
      ok: true,
      kind: "transfer",
      net: SOL_MAINNET,
      from: wallet,
      to: destAddr,
      tx: sig,
      amount: Number.parseFloat(amountUi),
      token: "USDC",
      label: `${destAddr.slice(0, 4)}...${destAddr.slice(-4)}`,
    });

    return {
      text: `Sent ${amountUi} USDC to \`${destAddr}\`\n[View transaction](https://solscan.io/tx/${sig})`,
    };
  } catch (err) {
    appendHistory(histPath, {
      t: Date.now(),
      ok: false,
      kind: "transfer",
      net: SOL_MAINNET,
      from: wallet,
      to: destAddr,
      token: "USDC",
      error: String(err).substring(0, 200),
    });
    const msg = String(err);
    const cause = (err as { cause?: { message?: string } }).cause?.message || "";
    const detail = cause || msg;
    if (detail.includes("insufficient") || detail.includes("lamports")) {
      return {
        text: "Send failed - insufficient SOL for fees\nBalance too low for transaction fees. Fund wallet with SOL.",
      };
    }
    return { text: `Send failed: ${detail}` };
  }
}

function handleHistory(histPath: string, page: number): { text: string } {
  const records = readHistory(histPath);
  const totalTxs = records.length;
  const start = (page - 1) * HISTORY_PAGE_SIZE;
  const fromEnd = totalTxs - start;
  const pageRecords = records.slice(Math.max(0, fromEnd - HISTORY_PAGE_SIZE), fromEnd).reverse();

  if (pageRecords.length === 0) {
    return { text: page === 1 ? "No transactions yet." : "No more transactions." };
  }

  const rangeStart = start + 1;
  const rangeEnd = start + pageRecords.length;
  const lines: string[] = [`**History** (${rangeStart}-${rangeEnd})`, ""];
  for (const r of pageRecords) {
    lines.push(formatTxLine(r));
  }

  const nav: string[] = [];
  if (page > 1) {
    nav.push(`Newer: \`/x_wallet history${page === 2 ? "" : ` ${page - 1}`}\``);
  }
  if (start + HISTORY_PAGE_SIZE < totalTxs) {
    nav.push(`Older: \`/x_wallet history ${page + 1}\``);
  }
  if (nav.length > 0) {
    lines.push("", nav.join(" · "));
  }

  return { text: lines.join("\n") };
}

export function createWalletCommand(ctx: CommandContext) {
  return {
    name: "x_wallet",
    description: "Wallet status, balance, send USDC, transaction history",
    acceptsArgs: true,
    handler: async (cmdCtx: { args?: string }) => {
      const walletAddress = ctx.getWalletAddress();
      if (!walletAddress) {
        return { text: "Wallet not loaded yet. Please wait for the gateway to finish starting." };
      }

      const args = cmdCtx.args?.trim() ?? "";
      const parts = args.split(/\s+/).filter(Boolean);

      if (parts[0]?.toLowerCase() === "send") {
        return handleSend(
          parts.slice(1),
          walletAddress,
          ctx.getSigner(),
          ctx.rpcUrl,
          ctx.historyPath,
        );
      }

      if (parts[0]?.toLowerCase() === "history") {
        const pageArg = parts[1];
        const page = pageArg ? Math.max(1, Number.parseInt(pageArg, 10) || 1) : 1;
        return handleHistory(ctx.historyPath, page);
      }

      // Default: combined status + balance view
      try {
        const snap = await getWalletSnapshot(ctx.rpcUrl, walletAddress, ctx.historyPath);

        const solscanUrl = `https://solscan.io/account/${walletAddress}`;
        const lines: string[] = [`x402-proxy v${__VERSION__}`];

        const defaultModel = ctx.allModels[0];
        if (defaultModel) {
          lines.push("", `**Model** - ${defaultModel.name} (${defaultModel.provider})`);
        }

        lines.push("", `**[Wallet](${solscanUrl})**`, `\`${walletAddress}\``);
        lines.push("", `  ${snap.sol} SOL`, `  ${snap.ui} USDC`);
        if (snap.spend.today > 0) {
          lines.push(`  -${snap.spend.today.toFixed(2)} USDC today`);
        }

        if (snap.tokens.length > 0) {
          const displayTokens = snap.tokens.slice(0, 10);
          const symbols = await resolveTokenSymbols(displayTokens.map((t) => t.mint));
          lines.push("", "**Tokens**");
          for (const t of displayTokens) {
            const sym = symbols.get(t.mint);
            const label = sym ?? `${t.mint.slice(0, 4)}...${t.mint.slice(-4)}`;
            const amt = Number.parseFloat(t.amount).toLocaleString("en-US", {
              maximumFractionDigits: 0,
            });
            lines.push(`  ${amt} ${label}`);
          }
          if (snap.tokens.length > 10) {
            lines.push(`  ...and ${snap.tokens.length - 10} more`);
          }
        }

        // Recent transactions (only show if few tokens to keep output manageable)
        if (snap.tokens.length <= INLINE_HISTORY_TOKEN_THRESHOLD) {
          const recentRecords = snap.records.slice(-STATUS_HISTORY_COUNT).reverse();
          if (recentRecords.length > 0) {
            lines.push("", "**Recent**");
            for (const r of recentRecords) {
              lines.push(formatTxLine(r));
            }
          }
        }

        lines.push("", "History: `/x_wallet history`");
        if (ctx.dashboardUrl) {
          lines.push(`[Dashboard](${ctx.dashboardUrl})`);
        }

        return { text: lines.join("\n") };
      } catch (err) {
        return { text: `Failed to check balance: ${String(err)}` };
      }
    },
  };
}
