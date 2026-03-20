import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { buildCommand, type CommandContext } from "@stricli/core";
import pc from "picocolors";
import { calcSpend, formatTxLine, readHistory } from "../history.js";
import { getHistoryPath } from "../lib/config.js";
import { dim, info } from "../lib/output.js";
import { resolveWallet } from "../lib/resolve-wallet.js";

const BASE_RPC = "https://mainnet.base.org";
const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
const TEMPO_RPC = "https://rpc.presto.tempo.xyz";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_TEMPO = "0x20C000000000000000000000b9537d11c60E8b50";
const USDC_SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

type RpcResult = { result?: string };
type SolanaBalanceResult = {
  result?: {
    value?: { uiAmountString: string };
  };
};

async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchEvmBalances(address: string): Promise<{ eth: string; usdc: string }> {
  const usdcData = `0x70a08231${address.slice(2).padStart(64, "0")}`;
  const [ethRes, usdcRes] = (await Promise.all([
    rpcCall(BASE_RPC, "eth_getBalance", [address, "latest"]),
    rpcCall(BASE_RPC, "eth_call", [{ to: USDC_BASE, data: usdcData }, "latest"]),
  ])) as [RpcResult, RpcResult];

  const eth = ethRes.result ? (Number(BigInt(ethRes.result)) / 1e18).toFixed(6) : "?";
  const usdc = usdcRes.result ? (Number(BigInt(usdcRes.result)) / 1e6).toFixed(4) : "?";
  return { eth, usdc };
}

export async function fetchTempoBalances(address: string): Promise<{ usdc: string }> {
  const usdcData = `0x70a08231${address.slice(2).padStart(64, "0")}`;
  const res = (await rpcCall(TEMPO_RPC, "eth_call", [
    { to: USDC_TEMPO, data: usdcData },
    "latest",
  ])) as RpcResult;
  const usdc = res.result ? (Number(BigInt(res.result)) / 1e6).toFixed(4) : "?";
  return { usdc };
}

async function getUsdcAta(owner: string): Promise<string> {
  const encoder = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: address(ATA_PROGRAM),
    seeds: [
      encoder.encode(address(owner)),
      encoder.encode(address(TOKEN_PROGRAM)),
      encoder.encode(address(USDC_SOLANA_MINT)),
    ],
  });
  return ata;
}

export async function fetchSolanaBalances(
  ownerAddress: string,
): Promise<{ sol: string; usdc: string }> {
  const ata = await getUsdcAta(ownerAddress);
  const [solRes, usdcRes] = (await Promise.all([
    rpcCall(SOLANA_RPC, "getBalance", [ownerAddress]),
    rpcCall(SOLANA_RPC, "getTokenAccountBalance", [ata]),
  ])) as [{ result?: { value?: number } }, SolanaBalanceResult];

  const sol = solRes.result?.value != null ? (solRes.result.value / 1e9).toFixed(6) : "?";
  const usdcVal = usdcRes.result?.value;
  const usdc = usdcVal
    ? Number(usdcVal.uiAmountString).toFixed(4)
    : usdcVal === undefined
      ? "?"
      : "0.0000";
  return { sol, usdc };
}

export function balanceLine(usdc: string, native: string, nativeSymbol: string): string {
  return pc.dim(` (${usdc} USDC, ${native} ${nativeSymbol})`);
}

export type AllBalances = {
  evm: { eth: string; usdc: string } | null;
  sol: { sol: string; usdc: string } | null;
  tempo: { usdc: string } | null;
};

export async function fetchAllBalances(
  evmAddress?: string,
  solanaAddress?: string,
): Promise<AllBalances> {
  const [evmResult, solResult, tempoResult] = await Promise.allSettled([
    evmAddress ? fetchEvmBalances(evmAddress) : Promise.resolve(null),
    solanaAddress ? fetchSolanaBalances(solanaAddress) : Promise.resolve(null),
    evmAddress ? fetchTempoBalances(evmAddress) : Promise.resolve(null),
  ]);
  return {
    evm: evmResult.status === "fulfilled" ? evmResult.value : null,
    sol: solResult.status === "fulfilled" ? solResult.value : null,
    tempo: tempoResult.status === "fulfilled" ? tempoResult.value : null,
  };
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

    const { evm, sol, tempo } = await fetchAllBalances(wallet.evmAddress, wallet.solanaAddress);

    if (wallet.evmAddress) {
      const bal = evm ? balanceLine(evm.usdc, evm.eth, "ETH") : pc.dim(" (network error)");
      console.log(`  Base:   ${pc.green(wallet.evmAddress)}${bal}`);
    }
    if (wallet.evmAddress) {
      const bal = tempo ? pc.dim(` (${tempo.usdc} USDC)`) : pc.dim(" (network error)");
      console.log(`  Tempo:  ${pc.green(wallet.evmAddress)}${bal}`);
    }
    if (wallet.solanaAddress) {
      const bal = sol ? balanceLine(sol.usdc, sol.sol, "SOL") : pc.dim(" (network error)");
      console.log(`  Solana: ${pc.green(wallet.solanaAddress)}${bal}`);
    }

    // Funding hint when all USDC balances are zero
    const evmEmpty = !evm || evm.usdc === "0.0000";
    const solEmpty = !sol || sol.usdc === "0.0000";
    const tempoEmpty = !tempo || tempo.usdc === "0.0000";
    if (evmEmpty && solEmpty && tempoEmpty) {
      console.log();
      dim("  Send USDC to any address above to start using paid APIs.");
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
