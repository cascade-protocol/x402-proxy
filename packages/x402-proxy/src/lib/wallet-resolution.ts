import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { privateKeyToAccount } from "viem/accounts";
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
  if (opts?.evmKey || opts?.solanaKey) {
    const result: WalletResolution = { source: "flag" };
    if (opts.evmKey) {
      const hex = opts.evmKey.startsWith("0x") ? opts.evmKey : `0x${opts.evmKey}`;
      result.evmKey = hex;
      result.evmAddress = privateKeyToAccount(hex as `0x${string}`).address;
    }
    if (opts.solanaKey) {
      result.solanaKey = parseSolanaKey(opts.solanaKey);
      result.solanaAddress = solanaAddressFromKey(result.solanaKey);
    }
    return result;
  }

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
      result.solanaKey = parseSolanaKey(envSol);
      result.solanaAddress = solanaAddressFromKey(result.solanaKey);
    }
    return result;
  }

  const envMnemonic = process.env.X402_PROXY_WALLET_MNEMONIC;
  if (envMnemonic) {
    return resolveFromMnemonic(envMnemonic, "mnemonic-env");
  }

  const walletFile = loadWalletFile();
  if (walletFile) {
    return resolveFromMnemonic(walletFile.mnemonic, "wallet-file");
  }

  return { source: "none" };
}

function resolveFromMnemonic(mnemonic: string, source: WalletSource): WalletResolution {
  const evm = deriveEvmKeypair(mnemonic);
  const sol = deriveSolanaKeypair(mnemonic);
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

function parseSolanaKey(input: string): Uint8Array {
  const trimmed = input.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    return new Uint8Array(arr);
  }
  return base58.decode(trimmed);
}

function solanaAddressFromKey(keyBytes: Uint8Array): string {
  if (keyBytes.length >= 64) return base58.encode(keyBytes.slice(32));
  return base58.encode(ed25519.getPublicKey(keyBytes));
}
