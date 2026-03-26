import * as prompts from "@clack/prompts";
import { buildCommand, type CommandContext } from "@stricli/core";
import pc from "picocolors";
import {
  getConfigDirShort,
  getWalletPath,
  isConfigured,
  loadWalletFile,
  type ProxyConfig,
  saveConfig,
  saveWalletFile,
  type WalletFile,
} from "../lib/config.js";
import { deriveEvmKeypair, deriveSolanaKeypair, generateMnemonic } from "../lib/derive.js";

export async function runSetup(opts?: {
  force?: boolean;
  nonInteractive?: boolean;
  importMnemonic?: string;
}) {
  const nonInteractive = opts?.nonInteractive ?? false;

  // Non-interactive: output existing wallet as JSON if already configured
  if (nonInteractive && isConfigured() && !opts?.force) {
    const walletFile = loadWalletFile();
    if (walletFile) {
      process.stdout.write(
        `${JSON.stringify({ base: walletFile.addresses.evm, tempo: walletFile.addresses.evm, solana: walletFile.addresses.solana })}\n`,
      );
      return;
    }
  }

  if (isConfigured() && !opts?.force) {
    prompts.log.warn(
      `Already configured. Wallet at ${pc.dim(getWalletPath())}\nTo reconfigure, run:\n  ${pc.cyan("$ npx x402-proxy setup --force")}`,
    );
    return;
  }

  let mnemonic: string;

  if (nonInteractive) {
    // Non-interactive: use provided mnemonic or auto-generate
    if (opts?.importMnemonic) {
      const words = opts.importMnemonic.trim().split(/\s+/);
      if (words.length !== 12 && words.length !== 24) {
        process.stderr.write("Error: mnemonic must be 12 or 24 words\n");
        process.exit(1);
      }
      mnemonic = opts.importMnemonic.trim();
    } else {
      mnemonic = generateMnemonic();
    }

    const evm = deriveEvmKeypair(mnemonic);
    const sol = deriveSolanaKeypair(mnemonic);

    const wallet: WalletFile = {
      version: 1,
      mnemonic,
      addresses: { evm: evm.address, solana: sol.address },
    };
    saveWalletFile(wallet);
    saveConfig({ preferredProtocol: "x402" });

    process.stdout.write(
      `${JSON.stringify({ base: evm.address, tempo: evm.address, solana: sol.address })}\n`,
    );
    return;
  }

  // Interactive flow
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
  prompts.log.success(`Tempo address:  ${pc.green(evm.address)}`);
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
      { value: "mpp", label: "MPP - machine payments over HTTP 402 (Tempo)" },
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

type SetupFlags = {
  force: boolean;
  nonInteractive: boolean;
  importMnemonic: string | undefined;
};

export const setupCommand = buildCommand<SetupFlags, [], CommandContext>({
  docs: {
    brief: "Set up x402-proxy wallet (generate new or import existing mnemonic)",
    fullDescription: `Set up x402-proxy wallet interactively, or use --non-interactive for automated environments.

Non-interactive mode auto-generates a wallet and outputs JSON to stdout:
  $ npx x402-proxy setup --non-interactive
  {"base":"0x...","tempo":"0x...","solana":"..."}

Import an existing mnemonic non-interactively:
  $ npx x402-proxy setup --non-interactive --import-mnemonic "word1 word2 ... word24"

If a wallet already exists, --non-interactive outputs the existing addresses.`,
  },
  parameters: {
    flags: {
      force: {
        kind: "boolean",
        brief: "Overwrite existing configuration",
        default: false,
      },
      nonInteractive: {
        kind: "boolean",
        brief: "Auto-generate wallet and output addresses as JSON (no prompts)",
        default: false,
      },
      importMnemonic: {
        kind: "parsed",
        brief: "Import a BIP-39 mnemonic (use with --non-interactive)",
        parse: String,
        optional: true,
      },
    },
    positional: { kind: "tuple", parameters: [] },
  },
  async func(flags) {
    await runSetup({
      force: flags.force,
      nonInteractive: flags.nonInteractive,
      importMnemonic: flags.importMnemonic,
    });
  },
});
