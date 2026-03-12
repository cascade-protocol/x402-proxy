/**
 * Wallet derivation from BIP-39 mnemonic.
 *
 * A single 24-word mnemonic is the root secret. Both Solana and EVM keypairs
 * are deterministically derived from it.
 *
 * Solana: SLIP-10 Ed25519 at m/44'/501'/0'/0'
 * EVM:    BIP-32 secp256k1  at m/44'/60'/0'/0/0
 *
 * Ported from agentbox/packages/openclaw-x402/src/wallet.ts
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58 } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { generateMnemonic as bip39Generate, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export function generateMnemonic(): string {
  return bip39Generate(wordlist, 256); // 24 words
}

/**
 * SLIP-10 Ed25519 derivation at m/44'/501'/0'/0' (Phantom/Backpack compatible).
 */
const enc = new TextEncoder();

export function deriveSolanaKeypair(mnemonic: string): {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  address: string;
} {
  const seed = mnemonicToSeedSync(mnemonic);

  let I = hmac(sha512, enc.encode("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chainCode = I.slice(32);

  for (const index of [0x8000002c, 0x800001f5, 0x80000000, 0x80000000]) {
    const data = new Uint8Array(37);
    data[0] = 0x00;
    data.set(key, 1);
    data[33] = (index >>> 24) & 0xff;
    data[34] = (index >>> 16) & 0xff;
    data[35] = (index >>> 8) & 0xff;
    data[36] = index & 0xff;
    I = hmac(sha512, chainCode, data);
    key = I.slice(0, 32);
    chainCode = I.slice(32);
  }

  const secretKey = new Uint8Array(key);
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey, address: base58.encode(publicKey) };
}

/**
 * BIP-32 secp256k1 derivation at m/44'/60'/0'/0/0.
 */
export function deriveEvmKeypair(mnemonic: string): {
  privateKey: string;
  address: string;
} {
  const seed = mnemonicToSeedSync(mnemonic);
  const hdKey = HDKey.fromMasterSeed(seed);
  const derived = hdKey.derive("m/44'/60'/0'/0/0");
  if (!derived.privateKey) throw new Error("Failed to derive EVM private key");

  const privateKey = `0x${Buffer.from(derived.privateKey).toString("hex")}`;

  const pubUncompressed = secp256k1.getPublicKey(derived.privateKey, false);
  const hash = keccak_256(pubUncompressed.slice(1));
  const addrHex = Buffer.from(hash.slice(-20)).toString("hex");

  return { privateKey, address: checksumAddress(addrHex) };
}

function checksumAddress(addr: string): string {
  const hash = Buffer.from(keccak_256(enc.encode(addr))).toString("hex");
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += Number.parseInt(hash[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i];
  }
  return out;
}
