import { buildCommand } from "@stricli/core";
import pc from "picocolors";
import { info } from "../lib/output.js";
import { resolveWallet } from "../lib/resolve-wallet.js";

export const walletInfoCommand = buildCommand({
  docs: {
    brief: "Show wallet addresses",
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
      console.log(pc.dim(`Or set ${pc.cyan("X402_PROXY_WALLET_MNEMONIC")} environment variable.`));
      process.exit(1);
    }

    console.log();
    info("Wallet");
    console.log();
    console.log(pc.dim(`  Source: ${wallet.source}`));
    if (wallet.evmAddress) console.log(`  EVM:    ${pc.green(wallet.evmAddress)}`);
    if (wallet.solanaAddress) console.log(`  Solana: ${pc.green(wallet.solanaAddress)}`);
    console.log();
  },
});
