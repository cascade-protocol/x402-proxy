import { buildCommand, type CommandContext } from "@stricli/core";
import pc from "picocolors";
import { calcSpend, formatTxLine, readHistory } from "../history.js";
import { getHistoryPath } from "../lib/config.js";
import { dim, info } from "../lib/output.js";
import { resolveWallet } from "../lib/resolve-wallet.js";

const BASE_RPC = "https://mainnet.base.org";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type RpcResult = { result?: string };
type SolanaTokenResult = {
  result?: {
    value?: Array<{
      account: { data: { parsed: { info: { tokenAmount: { uiAmountString: string } } } } };
    }>;
  };
};

async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  return res.json();
}

export async function fetchEvmBalances(address: string): Promise<{ eth: string; usdc: string }> {
  const usdcData = `0x70a08231${address.slice(2).padStart(64, "0")}`;
  const [ethRes, usdcRes] = (await Promise.all([
    rpcCall(BASE_RPC, "eth_getBalance", [address, "latest"]),
    rpcCall(BASE_RPC, "eth_call", [{ to: USDC_BASE, data: usdcData }, "latest"]),
  ])) as [RpcResult, RpcResult];

  const eth = ethRes.result ? (Number(BigInt(ethRes.result)) / 1e18).toFixed(6) : "?";
  const usdc = usdcRes.result ? (Number(BigInt(usdcRes.result)) / 1e6).toFixed(2) : "?";
  return { eth, usdc };
}

export async function fetchSolanaBalances(address: string): Promise<{ sol: string; usdc: string }> {
  const [solRes, usdcRes] = (await Promise.all([
    rpcCall(SOLANA_RPC, "getBalance", [address]),
    rpcCall(SOLANA_RPC, "getTokenAccountsByOwner", [
      address,
      { mint: USDC_SOLANA_MINT },
      { encoding: "jsonParsed" },
    ]),
  ])) as [{ result?: { value?: number } }, SolanaTokenResult];

  const sol = solRes.result?.value != null ? (solRes.result.value / 1e9).toFixed(6) : "?";
  const accounts = usdcRes.result?.value;
  const usdc = accounts?.length
    ? Number(accounts[0].account.data.parsed.info.tokenAmount.uiAmountString).toFixed(2)
    : "0.00";
  return { sol, usdc };
}

export function balanceLine(usdc: string, native: string, nativeSymbol: string): string {
  return pc.dim(` (${usdc} USDC, ${native} ${nativeSymbol})`);
}

export const walletInfoCommand = buildCommand<{ verbose: boolean }, [], CommandContext>({
  docs: {
    brief: "Show wallet addresses and balances",
  },
  parameters: {
    flags: {
      verbose: {
        kind: "boolean",
        brief: "Show transaction IDs",
        default: false,
      },
    },
    positional: { kind: "tuple", parameters: [] },
  },
  async func(flags) {
    const wallet = resolveWallet();

    if (wallet.source === "none") {
      console.log(pc.yellow("No wallet configured."));
      console.log(
        pc.dim(
          `\nRun:\n  ${pc.cyan("$ npx x402-proxy setup")}\n\nOr set ${pc.cyan("X402_PROXY_WALLET_MNEMONIC")} environment variable.`,
        ),
      );
      process.exit(1);
    }

    console.log();
    info("Wallet");
    console.log();
    console.log(pc.dim(`  Source: ${wallet.source}`));

    const [evmResult, solResult] = await Promise.allSettled([
      wallet.evmAddress ? fetchEvmBalances(wallet.evmAddress) : Promise.resolve(null),
      wallet.solanaAddress ? fetchSolanaBalances(wallet.solanaAddress) : Promise.resolve(null),
    ]);

    const evm = evmResult.status === "fulfilled" ? evmResult.value : null;
    const sol = solResult.status === "fulfilled" ? solResult.value : null;

    if (wallet.evmAddress) {
      const bal = evm ? balanceLine(evm.usdc, evm.eth, "ETH") : pc.dim(" (network error)");
      console.log(`  Base:   ${pc.green(wallet.evmAddress)}${bal}`);
    }
    if (wallet.solanaAddress) {
      const bal = sol ? balanceLine(sol.usdc, sol.sol, "SOL") : pc.dim(" (network error)");
      console.log(`  Solana: ${pc.green(wallet.solanaAddress)}${bal}`);
    }

    // Funding hint when both USDC balances are zero
    const evmEmpty = !evm || evm.usdc === "0.00";
    const solEmpty = !sol || sol.usdc === "0.00";
    if (evmEmpty && solEmpty) {
      console.log();
      dim("  Send USDC to either address above to start using x402 APIs.");
    }
    console.log();

    // Recent transactions
    const records = readHistory(getHistoryPath());
    if (records.length > 0) {
      const spend = calcSpend(records);
      const recent = records.slice(-10);
      dim("  Recent transactions:");
      for (const r of recent) {
        const line = formatTxLine(r, { verbose: flags.verbose }).replace(
          /\[([^\]]+)\]\([^)]+\)/g,
          "$1",
        );
        console.log(line);
      }
      console.log();
      console.log(
        pc.dim(
          `  Today: ${spend.today.toFixed(4)} USDC | Total: ${spend.total.toFixed(4)} USDC | ${spend.count} tx`,
        ),
      );
    } else {
      dim("  No transactions yet.");
    }
    console.log();

    // Hints
    console.log(pc.dim("  See also: wallet history, wallet export-key"));
    console.log();
  },
});
