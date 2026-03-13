import { describe, expect, it } from "vitest";
import { deriveEvmKeypair, deriveSolanaKeypair, generateMnemonic } from "./derive.js";

// Known test vector: a fixed mnemonic must always produce the same addresses.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

describe("generateMnemonic", () => {
  it("produces 24 words", () => {
    const m = generateMnemonic();
    expect(m.split(" ")).toHaveLength(24);
  });

  it("produces different mnemonics each call", () => {
    expect(generateMnemonic()).not.toBe(generateMnemonic());
  });
});

describe("deriveSolanaKeypair", () => {
  it("derives deterministic Solana address from mnemonic", () => {
    const a = deriveSolanaKeypair(TEST_MNEMONIC);
    const b = deriveSolanaKeypair(TEST_MNEMONIC);
    expect(a.address).toBe(b.address);
    expect(a.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/); // base58
  });

  it("returns 32-byte secret key and 32-byte public key", () => {
    const kp = deriveSolanaKeypair(TEST_MNEMONIC);
    expect(kp.secretKey).toHaveLength(32);
    expect(kp.publicKey).toHaveLength(32);
  });

  it("different mnemonic produces different address", () => {
    const other = generateMnemonic();
    const a = deriveSolanaKeypair(TEST_MNEMONIC);
    const b = deriveSolanaKeypair(other);
    expect(a.address).not.toBe(b.address);
  });
});

describe("deriveEvmKeypair", () => {
  it("derives deterministic EVM address from mnemonic", () => {
    const a = deriveEvmKeypair(TEST_MNEMONIC);
    const b = deriveEvmKeypair(TEST_MNEMONIC);
    expect(a.address).toBe(b.address);
    expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("returns 0x-prefixed private key", () => {
    const kp = deriveEvmKeypair(TEST_MNEMONIC);
    expect(kp.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("address has EIP-55 checksum", () => {
    const kp = deriveEvmKeypair(TEST_MNEMONIC);
    // Checksum address has mixed case (not all lowercase)
    expect(kp.address).not.toBe(kp.address.toLowerCase());
  });

  it("different mnemonic produces different address", () => {
    const other = generateMnemonic();
    const a = deriveEvmKeypair(TEST_MNEMONIC);
    const b = deriveEvmKeypair(other);
    expect(a.address).not.toBe(b.address);
  });
});

describe("cross-chain determinism", () => {
  it("same mnemonic always produces the same pair of addresses", () => {
    const evm = deriveEvmKeypair(TEST_MNEMONIC);
    const sol = deriveSolanaKeypair(TEST_MNEMONIC);

    // Snapshot: these addresses must never change across versions
    expect(evm.address).toBe("0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb");
    expect(sol.address).toBe("3Cy3YNTFywCmxoxt8n7UH6hg6dLo5uACowX3CFceaSnx");
  });
});
