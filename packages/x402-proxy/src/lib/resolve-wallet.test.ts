import { base58 } from "@scure/base";
import type { PaymentRequirements } from "@x402/fetch";
import { describe, expect, it } from "vitest";
import { deriveSolanaKeypair } from "./derive.js";
import {
  createNetworkFilter,
  createNetworkPreference,
  networkToCaipPrefix,
  resolveWallet,
} from "./resolve-wallet.js";

// --- Test fixtures ---

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

function makeReq(overrides: Partial<PaymentRequirements>): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:8453",
    asset: "USDC",
    amount: "100000",
    payTo: "0x1234",
    maxTimeoutSeconds: 60,
    extra: {},
    ...overrides,
  };
}

const baseReq = makeReq({ network: "eip155:8453" });
const solanaReq = makeReq({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
const bothReqs = [baseReq, solanaReq];

// --- networkToCaipPrefix ---

describe("networkToCaipPrefix", () => {
  it("maps 'base' to eip155:8453", () => {
    expect(networkToCaipPrefix("base")).toBe("eip155:8453");
  });

  it("maps 'solana' to solana: prefix", () => {
    expect(networkToCaipPrefix("solana")).toBe("solana:");
  });

  it("passes raw CAIP-2 through unchanged", () => {
    expect(networkToCaipPrefix("eip155:1")).toBe("eip155:1");
  });

  it("is case-insensitive", () => {
    expect(networkToCaipPrefix("Base")).toBe("eip155:8453");
    expect(networkToCaipPrefix("SOLANA")).toBe("solana:");
  });
});

// --- createNetworkFilter (hard --network flag) ---

describe("createNetworkFilter", () => {
  it("throws when network is unavailable", () => {
    const filter = createNetworkFilter("base");
    expect(() => filter(2, [solanaReq])).toThrow("Network 'base' not accepted");
    expect(() => filter(2, [solanaReq])).toThrow("Available: Solana");
  });

  it("returns only matching requirements for base", () => {
    const filter = createNetworkFilter("base");
    expect(filter(2, bothReqs)).toEqual([baseReq]);
  });

  it("returns only matching requirements for solana", () => {
    const filter = createNetworkFilter("solana");
    expect(filter(2, bothReqs)).toEqual([solanaReq]);
  });

  it("works with raw CAIP-2 input", () => {
    const filter = createNetworkFilter("eip155:8453");
    expect(filter(2, bothReqs)).toEqual([baseReq]);
  });
});

// --- createNetworkPreference (soft defaultNetwork) ---

describe("createNetworkPreference", () => {
  it("returns preferred network when available", () => {
    const selector = createNetworkPreference("base");
    expect(selector(2, bothReqs)).toEqual(baseReq);
  });

  it("falls back to first option when preference unavailable", () => {
    const selector = createNetworkPreference("base");
    expect(selector(2, [solanaReq])).toEqual(solanaReq);
  });

  it("selects solana when preferred", () => {
    const selector = createNetworkPreference("solana");
    expect(selector(2, bothReqs)).toEqual(solanaReq);
  });
});

// --- resolveWallet with --solana-key ---

describe("resolveWallet with solana key", () => {
  // Derive known keypair from test mnemonic to get a reference address
  const knownKeypair = deriveSolanaKeypair(TEST_MNEMONIC);
  // Build a 64-byte keypair (secret + public) and a 32-byte secret
  const fullKeypair = new Uint8Array(64);
  fullKeypair.set(knownKeypair.secretKey, 0);
  fullKeypair.set(knownKeypair.publicKey, 32);

  // Encode as JSON array (solana-keygen format)
  const jsonArrayKey = JSON.stringify(Array.from(fullKeypair));

  it("resolves address from base58 secret key", () => {
    const b58Key = base58.encode(knownKeypair.secretKey);
    const wallet = resolveWallet({ solanaKey: b58Key });
    expect(wallet.solanaAddress).toBe(knownKeypair.address);
    expect(wallet.source).toBe("flag");
  });

  it("resolves address from JSON array key", () => {
    const wallet = resolveWallet({ solanaKey: jsonArrayKey });
    expect(wallet.solanaAddress).toBe(knownKeypair.address);
  });

  it("both formats produce same address", () => {
    const b58Key = base58.encode(knownKeypair.secretKey);
    const fromB58 = resolveWallet({ solanaKey: b58Key });
    const fromJson = resolveWallet({ solanaKey: jsonArrayKey });
    expect(fromB58.solanaAddress).toBe(fromJson.solanaAddress);
  });
});
