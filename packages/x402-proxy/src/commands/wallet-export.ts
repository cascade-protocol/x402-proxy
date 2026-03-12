import { base58 } from "@scure/base";
import { buildCommand, type CommandContext } from "@stricli/core";
import { error, warn } from "../lib/output.js";
import { resolveWallet } from "../lib/resolve-wallet.js";

export const walletExportCommand = buildCommand<
  Record<string, never>,
  [chain: "evm" | "solana"],
  CommandContext
>({
  docs: {
    brief: "Export private key to stdout (pipe-safe)",
  },
  parameters: {
    flags: {},
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Chain to export: evm or solana",
          parse: (input: string) => {
            const v = input.toLowerCase();
            if (v !== "evm" && v !== "solana") throw new Error("Must be 'evm' or 'solana'");
            return v as "evm" | "solana";
          },
        },
      ],
    },
  },
  // biome-ignore lint/correctness/noUnusedFunctionParameters: required by Stricli callback signature
  func(flags, chain) {
    const wallet = resolveWallet();

    if (wallet.source === "none") {
      error("No wallet configured.");
      process.exit(1);
    }

    if (chain === "evm") {
      if (!wallet.evmKey) {
        error("No EVM key available.");
        process.exit(1);
      }
      warn("Warning: private key will be printed to stdout.");
      process.stdout.write(wallet.evmKey);
    } else {
      if (!wallet.solanaKey) {
        error("No Solana key available.");
        process.exit(1);
      }
      warn("Warning: private key will be printed to stdout.");
      // Export as base58-encoded secret key (first 32 bytes)
      process.stdout.write(base58.encode(wallet.solanaKey.slice(0, 32)));
    }
  },
});
