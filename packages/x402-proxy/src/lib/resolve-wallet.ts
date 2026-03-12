import { base58 } from "@scure/base";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import { x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { loadWalletFile } from "./config.js";
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

/**
 * Build a configured x402Client from resolved wallet keys.
 */
export async function buildX402Client(wallet: WalletResolution): Promise<x402Client> {
  const client = new x402Client();

  if (wallet.evmKey) {
    const hex = wallet.evmKey as `0x${string}`;
    const account = privateKeyToAccount(hex);
    const publicClient = createPublicClient({ chain: base, transport: http() });
    const signer = toClientEvmSigner(account, publicClient);
    client.register("eip155:8453", new ExactEvmScheme(signer));
  }

  if (wallet.solanaKey) {
    const { createKeyPairSignerFromBytes } = await import("@solana/kit");
    const signer = await createKeyPairSignerFromBytes(wallet.solanaKey);
    client.register("solana:mainnet", new ExactSvmScheme(signer));
    client.register("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", new ExactSvmScheme(signer));
  }

  return client;
}
