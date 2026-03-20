import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { toClientEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { type PaymentPolicy, type SelectPaymentRequirements, x402Client } from "@x402/fetch";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { calcSpend, displayNetwork, readHistory } from "../history.js";
import { getHistoryPath, loadWalletFile } from "./config.js";
import { deriveEvmKeypair, deriveSolanaKeypair } from "./derive.js";

export type WalletSource = "flag" | "env" | "mnemonic-env" | "wallet-file" | "none";

export type WalletResolution = {
  evmKey?: string;
  solanaKey?: Uint8Array;
  evmAddress?: string;
  solanaAddress?: string;
  source: WalletSource;
};

/**
 * Resolve wallet keys following the priority cascade:
 * 1. Flags (--evm-key / --solana-key as raw key strings)
 * 2. X402_PROXY_WALLET_EVM_KEY / X402_PROXY_WALLET_SOLANA_KEY env vars
 * 3. X402_PROXY_WALLET_MNEMONIC env var (derives both)
 * 4. ~/.config/x402-proxy/wallet.json (mnemonic file)
 */
export function resolveWallet(opts?: { evmKey?: string; solanaKey?: string }): WalletResolution {
  // 1. Flags
  if (opts?.evmKey || opts?.solanaKey) {
    const result: WalletResolution = { source: "flag" };
    if (opts.evmKey) {
      const hex = opts.evmKey.startsWith("0x") ? opts.evmKey : `0x${opts.evmKey}`;
      result.evmKey = hex;
      result.evmAddress = privateKeyToAccount(hex as `0x${string}`).address;
    }
    if (opts.solanaKey) {
      // Accept base58 secret key or JSON array format
      result.solanaKey = parsesolanaKey(opts.solanaKey);
      result.solanaAddress = solanaAddressFromKey(result.solanaKey);
    }
    return result;
  }

  // 2. Individual env vars
  const envEvm = process.env.X402_PROXY_WALLET_EVM_KEY;
  const envSol = process.env.X402_PROXY_WALLET_SOLANA_KEY;
  if (envEvm || envSol) {
    const result: WalletResolution = { source: "env" };
    if (envEvm) {
      const hex = envEvm.startsWith("0x") ? envEvm : `0x${envEvm}`;
      result.evmKey = hex;
      result.evmAddress = privateKeyToAccount(hex as `0x${string}`).address;
    }
    if (envSol) {
      result.solanaKey = parsesolanaKey(envSol);
      result.solanaAddress = solanaAddressFromKey(result.solanaKey);
    }
    return result;
  }

  // 3. Mnemonic env var
  const envMnemonic = process.env.X402_PROXY_WALLET_MNEMONIC;
  if (envMnemonic) {
    return resolveFromMnemonic(envMnemonic, "mnemonic-env");
  }

  // 4. Wallet file
  const walletFile = loadWalletFile();
  if (walletFile) {
    return resolveFromMnemonic(walletFile.mnemonic, "wallet-file");
  }

  return { source: "none" };
}

function resolveFromMnemonic(mnemonic: string, source: WalletSource): WalletResolution {
  const evm = deriveEvmKeypair(mnemonic);
  const sol = deriveSolanaKeypair(mnemonic);
  // Full 64-byte keypair: 32 secret + 32 public
  const solanaKey = new Uint8Array(64);
  solanaKey.set(sol.secretKey, 0);
  solanaKey.set(sol.publicKey, 32);

  return {
    evmKey: evm.privateKey,
    evmAddress: evm.address,
    solanaKey,
    solanaAddress: sol.address,
    source,
  };
}

function parsesolanaKey(input: string): Uint8Array {
  const trimmed = input.trim();
  // JSON array format (solana-keygen style)
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    return new Uint8Array(arr);
  }
  // Base58 encoded secret key
  return base58.decode(trimmed);
}

function solanaAddressFromKey(keyBytes: Uint8Array): string {
  // 64-byte keypair: public key is the last 32 bytes
  if (keyBytes.length >= 64) return base58.encode(keyBytes.slice(32));
  // 32-byte secret: derive public key
  return base58.encode(ed25519.getPublicKey(keyBytes));
}

export function networkToCaipPrefix(name: string): string {
  switch (name.toLowerCase()) {
    case "base":
      return "eip155:8453";
    case "tempo":
      return "eip155:4217";
    case "solana":
      return "solana:";
    default:
      return name;
  }
}

export function createNetworkFilter(network: string): PaymentPolicy {
  const prefix = networkToCaipPrefix(network);
  return (_version, reqs) => {
    const filtered = reqs.filter((r) => r.network.startsWith(prefix));
    if (filtered.length === 0) {
      const available = [...new Set(reqs.map((r) => displayNetwork(r.network)))].join(", ");
      throw new Error(`Network '${network}' not accepted. Available: ${available}`);
    }
    return filtered;
  };
}

export function createNetworkPreference(network: string): SelectPaymentRequirements {
  const prefix = networkToCaipPrefix(network);
  return (_version, accepts) => {
    return accepts.find((r) => r.network.startsWith(prefix)) || accepts[0];
  };
}

export type BuildClientOptions = {
  preferredNetwork?: string;
  /** Hard filter: fail if server doesn't accept this network */
  network?: string;
  spendLimitDaily?: number;
  spendLimitPerTx?: number;
};

/**
 * Build a configured x402Client from resolved wallet keys.
 */
export async function buildX402Client(
  wallet: WalletResolution,
  opts?: BuildClientOptions,
): Promise<x402Client> {
  const selector = opts?.preferredNetwork
    ? createNetworkPreference(opts.preferredNetwork)
    : undefined;

  const client = new x402Client(selector);

  if (wallet.evmKey) {
    const hex = wallet.evmKey as `0x${string}`;
    const account = privateKeyToAccount(hex);
    const publicClient = createPublicClient({ chain: base, transport: http() });
    const signer = toClientEvmSigner(account, publicClient);
    registerExactEvmScheme(client, { signer });
  }

  if (wallet.solanaKey) {
    const { createKeyPairSignerFromBytes } = await import("@solana/kit");
    const signer = await createKeyPairSignerFromBytes(wallet.solanaKey);
    registerExactSvmScheme(client, { signer });
  }

  if (opts?.network) {
    client.registerPolicy(createNetworkFilter(opts.network));
  }

  // Spend limit policies
  const daily = opts?.spendLimitDaily;
  const perTx = opts?.spendLimitPerTx;
  if (daily || perTx) {
    client.registerPolicy((_version, reqs) => {
      if (daily) {
        const spend = calcSpend(readHistory(getHistoryPath()));
        if (spend.today >= daily) {
          throw new Error(`Daily spend limit reached (${spend.today.toFixed(4)}/${daily} USDC)`);
        }
        const remaining = daily - spend.today;
        reqs = reqs.filter((r) => Number(r.amount) / 1_000_000 <= remaining);
        if (reqs.length === 0) {
          throw new Error(
            `Daily spend limit of ${daily} USDC would be exceeded (${spend.today.toFixed(4)} spent today)`,
          );
        }
      }
      if (perTx) {
        const before = reqs.length;
        reqs = reqs.filter((r) => Number(r.amount) / 1_000_000 <= perTx);
        if (reqs.length === 0 && before > 0) {
          throw new Error(`Payment exceeds per-transaction limit of ${perTx} USDC`);
        }
      }
      return reqs;
    });
  }

  return client;
}
