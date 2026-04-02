import type { KeyPairSigner } from "@solana/kit";
import { appendHistory, formatTxLine, readHistory } from "../history.js";
import { createWalletFile, getWalletPath, saveWalletFile } from "../lib/config.js";
import { generateMnemonic, isValidMnemonic } from "../lib/derive.js";
import type { PaymentProtocol } from "./defaults.js";
import { checkAtaExists, getUsdcBalance, transferUsdc } from "./solana.js";
import { getWalletSnapshot, type ModelEntry, SOL_MAINNET } from "./tools.js";

declare const __VERSION__: string;

const HISTORY_PAGE_SIZE = 5;
const STATUS_HISTORY_COUNT = 3;
const INLINE_HISTORY_TOKEN_THRESHOLD = 3;
const SEND_CONFIRM_TTL_MS = 5 * 60 * 1000;
const TOKEN_SYMBOL_CACHE_MAX = 200;

const tokenSymbolCache = new Map<string, string>();
const pendingSends = new Map<string, { amount: string; destination: string; createdAt: number }>();

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
  ensureReady: (opts?: { reload?: boolean }) => Promise<void>;
  getSolanaWalletAddress: () => string | null;
  getEvmWalletAddress: () => string | null;
  getSigner: () => KeyPairSigner | null;
  getDefaultRequestProtocol: () => PaymentProtocol;
  getDefaultMppSessionBudget: () => string;
  rpcUrl: string;
  dashboardUrl: string;
  historyPath: string;
  allModels: Pick<ModelEntry, "provider" | "id" | "name">[];
};

type SlashCommandContext = {
  senderId?: string;
  channel: string;
  accountId?: string;
  from?: string;
  messageThreadId?: string | number;
  args?: string;
};

function senderKey(cmdCtx: SlashCommandContext): string {
  return [
    cmdCtx.channel,
    cmdCtx.accountId ?? "",
    cmdCtx.senderId ?? cmdCtx.from ?? "",
    String(cmdCtx.messageThreadId ?? ""),
  ].join(":");
}

async function executeSend(
  amountStr: string,
  destination: string,
  wallet: string,
  signer: KeyPairSigner | null,
  rpc: string,
  histPath: string,
): Promise<{ text: string }> {
  if (!signer) {
    return { text: "Wallet not loaded yet. Please wait for the gateway to finish starting." };
  }

  try {
    const recipientHasAta = await checkAtaExists(rpc, destination);
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

    const sig = await transferUsdc(signer, rpc, destination, amountRaw);
    appendHistory(histPath, {
      t: Date.now(),
      ok: true,
      kind: "transfer",
      net: SOL_MAINNET,
      from: wallet,
      to: destination,
      tx: sig,
      amount: Number.parseFloat(amountUi),
      token: "USDC",
      label: `${destination.slice(0, 4)}...${destination.slice(-4)}`,
    });

    return {
      text: `Sent ${amountUi} USDC to \`${destination}\`\n[View transaction](https://solscan.io/tx/${sig})`,
    };
  } catch (err) {
    appendHistory(histPath, {
      t: Date.now(),
      ok: false,
      kind: "transfer",
      net: SOL_MAINNET,
      from: wallet,
      to: destination,
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

async function handleSetup(ctx: CommandContext, parts: string[]): Promise<{ text: string }> {
  const action = parts[0]?.toLowerCase();

  let mnemonic: string | null = null;
  if (action === "generate") {
    mnemonic = generateMnemonic();
  } else if (action === "import") {
    const words = parts.slice(1);
    if (words.length !== 12 && words.length !== 24) {
      return {
        text: "Mnemonic must be 12 or 24 words.\nUsage: `/x_wallet setup import word1 word2 ... word24`",
      };
    }
    mnemonic = words.join(" ");
    if (!isValidMnemonic(mnemonic)) {
      return { text: "Invalid BIP-39 mnemonic. Check the words and try again." };
    }
  }

  if (!mnemonic) {
    return {
      text: [
        "No wallet configured.",
        "",
        "  `/x_wallet setup generate` - generate a new wallet",
        "  `/x_wallet setup import <mnemonic>` - import a BIP-39 mnemonic (12 or 24 words)",
      ].join("\n"),
    };
  }

  const wallet = createWalletFile(mnemonic);
  saveWalletFile(wallet);
  await ctx.ensureReady({ reload: true });

  const lines = [
    action === "generate" ? "Wallet generated." : "Wallet imported.",
    "",
    `**EVM**: \`${wallet.addresses.evm}\``,
    `**Solana**: \`${wallet.addresses.solana}\``,
    "",
    `Saved to \`${getWalletPath()}\``,
  ];
  if (action === "generate") {
    lines.push(
      "Fund these addresses with USDC to start using paid tools.",
      "",
      "Recover mnemonic later: `npx x402-proxy wallet export-key mnemonic`",
    );
  }
  return { text: lines.join("\n") };
}

export function createWalletCommand(ctx: CommandContext) {
  return {
    name: "x_wallet",
    description: "Wallet status, balances, payment readiness, and transaction history",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (cmdCtx: SlashCommandContext) => {
      await ctx.ensureReady();

      const args = cmdCtx.args?.trim() ?? "";
      const parts = args.split(/\s+/).filter(Boolean);
      const sub = parts[0]?.toLowerCase();

      if (sub === "setup") {
        return handleSetup(ctx, parts.slice(1));
      }

      const solanaWallet = ctx.getSolanaWalletAddress();
      const evmWallet = ctx.getEvmWalletAddress();
      if (!solanaWallet && !evmWallet) {
        return handleSetup(ctx, []);
      }

      if (sub === "history") {
        const pageArg = parts[1];
        const page = pageArg ? Math.max(1, Number.parseInt(pageArg, 10) || 1) : 1;
        return handleHistory(ctx.historyPath, page);
      }

      if (parts[0]?.toLowerCase() === "send") {
        return { text: "Use `/x_send <amount|all> <address>` for transfers." };
      }

      try {
        const snap = await getWalletSnapshot(ctx.rpcUrl, solanaWallet, evmWallet, ctx.historyPath);

        const lines: string[] = [`x402-proxy v${__VERSION__}`];

        lines.push("", `**Protocol** - ${ctx.getDefaultRequestProtocol()}`);
        lines.push(`MPP session budget: ${ctx.getDefaultMppSessionBudget()} USDC`);
        lines.push(`MPP ready: ${evmWallet ? "yes" : "no"}`);
        lines.push(`x402 ready: ${solanaWallet ? "yes" : "no"}`);

        if (evmWallet) {
          lines.push("", "**EVM / Tempo**");
          lines.push(`\`${evmWallet}\``);
          lines.push(`  Base: ${snap.balances.evm?.usdc ?? "?"} USDC`);
          lines.push(`  Tempo: ${snap.balances.tempo?.usdc ?? "?"} USDC`);
        }

        if (solanaWallet) {
          const solscanUrl = `https://solscan.io/account/${solanaWallet}`;
          lines.push("", `**[Solana Wallet](${solscanUrl})**`, `\`${solanaWallet}\``);
          lines.push(`  ${snap.sol} SOL`, `  ${snap.ui} USDC`);
          if (snap.spend.today > 0) {
            lines.push(`  -${snap.spend.today.toFixed(2)} USDC today`);
          }
        }

        if (snap.tokens.length > 0) {
          const displayTokens = snap.tokens.slice(0, 10);
          const symbols = await resolveTokenSymbols(displayTokens.map((t) => t.mint));
          lines.push("", "**Solana Tokens**");
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

        if (snap.tokens.length <= INLINE_HISTORY_TOKEN_THRESHOLD) {
          const recentRecords = snap.records.slice(-STATUS_HISTORY_COUNT).reverse();
          if (recentRecords.length > 0) {
            lines.push("", "**Recent**");
            for (const r of recentRecords) {
              lines.push(formatTxLine(r));
            }
          }
        }

        if (!evmWallet) {
          lines.push(
            "",
            "MPP setup: add an EVM wallet via `x402-proxy setup` or `X402_PROXY_WALLET_EVM_KEY`.",
          );
        }
        if (!solanaWallet) {
          lines.push("", "x402 setup: add a Solana wallet or mnemonic if you need Solana x402.");
        }

        lines.push("", "History: `/x_wallet history`", "Send: `/x_send <amount|all> <address>`");
        if (ctx.dashboardUrl) {
          lines.push(`[Dashboard](${ctx.dashboardUrl})`);
        }

        return { text: lines.join("\n") };
      } catch (err) {
        return { text: `Failed to check wallet status: ${String(err)}` };
      }
    },
  };
}

export function createSendCommand(ctx: CommandContext) {
  return {
    name: "x_send",
    description: "Send USDC from the plugin wallet with an explicit confirmation step",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (cmdCtx: SlashCommandContext) => {
      await ctx.ensureReady();
      const wallet = ctx.getSolanaWalletAddress();
      if (!wallet) {
        return {
          text: "No Solana wallet configured. `/x_send` only works with the Solana USDC wallet.",
        };
      }

      const key = senderKey(cmdCtx);
      const now = Date.now();
      const pending = pendingSends.get(key);
      if (pending && now - pending.createdAt > SEND_CONFIRM_TTL_MS) {
        pendingSends.delete(key);
      }

      const args = cmdCtx.args?.trim() ?? "";
      const parts = args.split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        return {
          text: "Usage: `/x_send <amount|all> <address>`\nConfirm with `/x_send confirm`\nCancel with `/x_send cancel`",
        };
      }

      if (parts[0]?.toLowerCase() === "confirm") {
        const next = pendingSends.get(key);
        if (!next) {
          return { text: "No pending transfer to confirm." };
        }
        pendingSends.delete(key);
        return executeSend(
          next.amount,
          next.destination,
          wallet,
          ctx.getSigner(),
          ctx.rpcUrl,
          ctx.historyPath,
        );
      }

      if (parts[0]?.toLowerCase() === "cancel") {
        pendingSends.delete(key);
        return { text: "Pending transfer cleared." };
      }

      if (parts.length !== 2) {
        return {
          text: "Usage: `/x_send <amount|all> <address>`\nExample: `/x_send 0.5 7xKXtg...`",
        };
      }

      const [amount, destination] = parts;
      if (destination.length < 32 || destination.length > 44) {
        return { text: `Invalid Solana address: ${destination}` };
      }

      pendingSends.set(key, { amount, destination, createdAt: now });
      return {
        text:
          `Pending transfer: send ${amount} USDC to \`${destination}\`\n` +
          `Confirm within 5 minutes with \`/x_send confirm\`\n` +
          `Cancel with \`/x_send cancel\``,
      };
    },
  };
}
