import { buildCommand } from "@stricli/core";
import pc from "picocolors";
import { calcSpend, formatTxLine, readHistory } from "../history.js";
import { getConfigDirShort, getHistoryPath, loadConfig } from "../lib/config.js";
import { dim } from "../lib/output.js";
import { resolveWallet } from "../lib/resolve-wallet.js";
import { balanceLine, fetchEvmBalances, fetchSolanaBalances } from "./wallet.js";

export async function displayStatus() {
  const wallet = resolveWallet();
  const config = loadConfig();
  const records = readHistory(getHistoryPath());
  const spend = calcSpend(records);

  console.log();
  console.log(pc.cyan(pc.bold("x402-proxy")));
  console.log(pc.dim("curl for x402 paid APIs"));
  console.log();

  // Wallet
  if (wallet.source === "none") {
    console.log(pc.yellow("  No wallet configured."));
    console.log(pc.dim(`  Run ${pc.cyan("$ npx x402-proxy setup")} to create one.`));
  } else {
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

    // Spend limits
    if (config?.spendLimitDaily || config?.spendLimitPerTx) {
      console.log();
      if (config.spendLimitDaily) {
        const pct =
          config.spendLimitDaily > 0 ? Math.round((spend.today / config.spendLimitDaily) * 100) : 0;
        dim(
          `  Daily limit:    ${spend.today.toFixed(4)} / ${config.spendLimitDaily} USDC (${pct}%)`,
        );
      }
      if (config.spendLimitPerTx) {
        dim(`  Per-tx limit:   ${config.spendLimitPerTx} USDC`);
      }
    }
  }
  console.log();

  // Recent transactions
  if (spend.count > 0) {
    const recent = records.slice(-5);
    dim("  Recent transactions:");
    for (const r of recent) {
      const line = formatTxLine(r).replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
      console.log(line);
    }
    console.log();
    dim(
      `  Today: ${spend.today.toFixed(4)} USDC | Total: ${spend.total.toFixed(4)} USDC | ${spend.count} tx`,
    );
  } else {
    dim("  No payment history yet.");
  }
  console.log();

  // Footer
  if (config?.defaultNetwork) dim(`  Network: ${config.defaultNetwork}`);
  dim(`  Config:  ${getConfigDirShort()}`);
}

export const statusCommand = buildCommand({
  docs: {
    brief: "Show configuration and wallet status",
  },
  parameters: {
    flags: {},
    positional: { kind: "tuple", parameters: [] },
  },
  async func() {
    await displayStatus();
    console.log();
  },
});
