import * as prompts from "@clack/prompts";
import { buildCommand, type CommandContext } from "@stricli/core";
import pc from "picocolors";
import {
  getConfigDirShort,
  getWalletPath,
  isConfigured,
  type ProxyConfig,
  saveConfig,
  saveWalletFile,
  type WalletFile,
} from "../lib/config.js";
import { deriveEvmKeypair, deriveSolanaKeypair, generateMnemonic } from "../lib/derive.js";

export async function runSetup(opts?: { force?: boolean }) {
  if (isConfigured() && !opts?.force) {
    prompts.log.warn(
      `Already configured. Wallet at ${pc.dim(getWalletPath())}\nTo reconfigure, run:\n  ${pc.cyan("$ npx x402-proxy setup --force")}`,
    );
    return;
  }

  prompts.intro(pc.cyan("x402-proxy setup"));

  prompts.log.info(
    "This will generate a single BIP-39 mnemonic that derives wallets for both Solana and EVM chains.",
  );

  const action = await prompts.select({
    message: "How would you like to set up your wallet?",
    options: [
      { value: "generate", label: "Generate a new mnemonic" },
      { value: "import", label: "Import an existing mnemonic" },
    ],
  });

  if (prompts.isCancel(action)) {
    prompts.cancel("Setup cancelled.");
    process.exit(0);
  }

  let mnemonic: string;

  if (action === "generate") {
    mnemonic = generateMnemonic();
    prompts.log.warn("Write down your mnemonic and store it safely. It will NOT be shown again.");
    prompts.log.message(pc.bold(mnemonic));
  } else {
    const input = await prompts.text({
      message: "Enter your 24-word mnemonic:",
      validate: (v = "") => {
        const words = v.trim().split(/\s+/);
        if (words.length !== 12 && words.length !== 24) return "Mnemonic must be 12 or 24 words";
      },
    });
    if (prompts.isCancel(input)) {
      prompts.cancel("Setup cancelled.");
      process.exit(0);
    }
    mnemonic = (input as string).trim();
  }

  const evm = deriveEvmKeypair(mnemonic);
  const sol = deriveSolanaKeypair(mnemonic);

  prompts.log.success(`Base address:   ${pc.green(evm.address)}`);
  prompts.log.success(`Solana address: ${pc.green(sol.address)}`);

  const wallet: WalletFile = {
    version: 1,
    mnemonic,
    addresses: { evm: evm.address, solana: sol.address },
  };

  saveWalletFile(wallet);

  // Payment preferences
  const protocol = await prompts.select({
    message: "Preferred payment protocol?",
    options: [
      { value: "x402", label: "x402 - on-chain payments (Base, Solana)" },
      { value: "mpp", label: "MPP - streaming micropayments (Tempo)" },
    ],
  });
  if (prompts.isCancel(protocol)) {
    prompts.cancel("Setup cancelled.");
    process.exit(0);
  }

  const networkOptions =
    protocol === "mpp"
      ? [{ value: "tempo", label: "Tempo" }]
      : [
          { value: "auto", label: "Auto-detect (pick chain with highest balance)" },
          { value: "base", label: "Base (EVM)" },
          { value: "solana", label: "Solana" },
        ];

  const network = await prompts.select({
    message: "Preferred network?",
    options: networkOptions,
  });
  if (prompts.isCancel(network)) {
    prompts.cancel("Setup cancelled.");
    process.exit(0);
  }

  const config: ProxyConfig = {
    preferredProtocol: protocol as "x402" | "mpp",
  };
  if (network !== "auto") {
    config.defaultNetwork = network as string;
  }

  saveConfig(config);

  prompts.log.info(`Config directory: ${pc.dim(getConfigDirShort())}`);

  prompts.log.step("Fund your wallets to start using x402 resources:");
  prompts.log.message(`  Solana (USDC): Send USDC to ${pc.cyan(sol.address)}`);
  prompts.log.message(`  Base (USDC):   Send USDC to ${pc.cyan(evm.address)}`);

  prompts.log.step("Try your first request:");
  prompts.log.message(
    `  ${pc.cyan("$ npx x402-proxy https://twitter.surf.cascade.fyi/users/cascade_fyi")}`,
  );

  prompts.outro(pc.green("Setup complete!"));
}

export const setupCommand = buildCommand<{ force: boolean }, [], CommandContext>({
  docs: {
    brief: "Set up x402-proxy with a new wallet",
  },
  parameters: {
    flags: {
      force: {
        kind: "boolean",
        brief: "Overwrite existing configuration",
        default: false,
      },
    },
    positional: { kind: "tuple", parameters: [] },
  },
  async func(flags) {
    await runSetup({ force: flags.force });
  },
});
