import { buildCommand } from "@stricli/core";
import pc from "picocolors";
import { getConfigDir, getHistoryPath, loadConfig } from "../lib/config.js";
import { resolveWallet } from "../lib/resolve-wallet.js";
import { dim, info } from "../lib/output.js";
import { calcSpend, readHistory } from "../history.js";

export const statusCommand = buildCommand({
  docs: {
    brief: "Show configuration and wallet status",
  },
  parameters: {
    flags: {},
    positional: { kind: "tuple", parameters: [] },
  },
  func() {
    const wallet = resolveWallet();
    const config = loadConfig();

    console.log();
    info("x402-proxy status");
    console.log();

    // Config
    dim(`  Config directory: ${getConfigDir()}`);
    if (config) {
      if (config.spendLimit) dim(`  Spend limit:      ${config.spendLimit} USDC`);
      if (config.defaultNetwork) dim(`  Default network:  ${config.defaultNetwork}`);
    }
    console.log();

    // Wallet
    if (wallet.source === "none") {
      console.log(pc.yellow("  No wallet configured."));
      console.log(pc.dim(`  Run ${pc.cyan("x402-proxy setup")} to create one.`));
    } else {
      dim(`  Wallet source: ${wallet.source}`);
      if (wallet.evmAddress) console.log(`  EVM:    ${pc.green(wallet.evmAddress)}`);
      if (wallet.solanaAddress) console.log(`  Solana: ${pc.green(wallet.solanaAddress)}`);
    }
    console.log();

    // Spend
    const historyPath = getHistoryPath();
    const records = readHistory(historyPath);
    const spend = calcSpend(records);
    if (spend.count > 0) {
      dim(`  Transactions: ${spend.count}`);
      dim(`  Today:        ${spend.today.toFixed(4)} USDC`);
      dim(`  Total:        ${spend.total.toFixed(4)} USDC`);
    } else {
      dim("  No payment history yet.");
    }
    console.log();
  },
});
