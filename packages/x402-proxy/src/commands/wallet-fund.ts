import { buildCommand } from "@stricli/core";
import pc from "picocolors";
import { resolveWallet } from "../lib/resolve-wallet.js";
import { info } from "../lib/output.js";

export const walletFundCommand = buildCommand({
  docs: {
    brief: "Show wallet funding instructions",
  },
  parameters: {
    flags: {},
    positional: { kind: "tuple", parameters: [] },
  },
  func() {
    const wallet = resolveWallet();

    if (wallet.source === "none") {
      console.log(pc.yellow("No wallet configured."));
      console.log(pc.dim(`Run ${pc.cyan("x402-proxy setup")} to create one.`));
      process.exit(1);
    }

    console.log();
    info("Funding Instructions");
    console.log();

    if (wallet.solanaAddress) {
      console.log(pc.bold("  Solana (USDC):"));
      console.log(`  Send USDC to: ${pc.green(wallet.solanaAddress)}`);
      console.log(pc.dim("  Network: Solana Mainnet"));
      console.log();
    }

    if (wallet.evmAddress) {
      console.log(pc.bold("  Base (USDC):"));
      console.log(`  Send USDC to: ${pc.green(wallet.evmAddress)}`);
      console.log(pc.dim("  Network: Base (Chain ID 8453)"));
      console.log();
    }

    console.log(
      pc.dim("  Tip: Most x402 services accept USDC on Base or Solana."),
    );
    console.log();
  },
});
