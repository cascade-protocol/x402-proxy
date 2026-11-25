import { base58 } from "@scure/base";
import {
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import type { PaymentRequirements } from "@x402/fetch";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPreferredNetwork } from "../commands/wallet.js";
import { deriveSolanaKeypair } from "./derive.js";
import { OptimizedSvmScheme } from "./optimized-svm-scheme.js";
import {
  buildX402Client,
  createAddressValidationPolicy,
  createNetworkFilter,
  createNetworkPreference,
  networkToCaipPrefix,
  resolveWallet,
} from "./resolve-wallet.js";

// --- Test fixtures ---

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
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
const tempoReq = makeReq({ network: "eip155:4217" });
const bothReqs = [baseReq, solanaReq];
const allReqs = [baseReq, solanaReq, tempoReq];

describe("configured Solana spend limits", () => {
  it.each([
    { perTx: undefined, expected: "selected Solana" },
    { perTx: 3, expected: "selected Solana" },
    { perTx: 1, expected: "exceeds per-transaction limit" },
  ])("applies the proxy limit of $perTx to a 2 USDC offer", async ({ perTx, expected }) => {
    const keypair = deriveSolanaKeypair(TEST_MNEMONIC);
    const client = await buildX402Client(
      { source: "flag", solanaKey: new Uint8Array([...keypair.secretKey, ...keypair.publicKey]) },
      { network: "solana", spendLimitPerTx: perTx },
    );
    client.onBeforePaymentCreation(async () => ({ abort: true, reason: "selected Solana" }));
    await expect(
      client.createPaymentPayload({
        x402Version: 2,
        resource: { url: "https://example.test" },
        accepts: [
          {
            ...solanaReq,
            asset: USDC_MINT,
            amount: "2000000",
            payTo: keypair.address,
          },
        ],
      }),
    ).rejects.toThrow(expected);
  });
});

it("selects a network using only the two USDC balances and a shared deadline", async ({
  onTestFinished,
}) => {
  const methods: string[] = [];
  const signals = new Set<AbortSignal | null | undefined>();
  const timeout = vi.spyOn(AbortSignal, "timeout");
  onTestFinished(() => {
    timeout.mockRestore();
    vi.unstubAllGlobals();
  });
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const { method } = JSON.parse(String(init.body));
    methods.push(method);
    signals.add(init.signal);
    return Response.json({
      result: method === "eth_call" ? "0xf4240" : { value: { uiAmountString: "2" } },
    });
  });
  expect(
    await detectPreferredNetwork({ evmAddress: baseReq.payTo, solanaAddress: USDC_MINT }),
  ).toBe("solana");
  expect(methods.sort()).toEqual(["eth_call", "getTokenAccountBalance"]);
  expect(timeout).toHaveBeenCalledWith(3000);
  expect([...signals]).toEqual([timeout.mock.results[0].value]);
});

it("rejects an unlisted Base asset before signing", async () => {
  const client = await buildX402Client({ source: "flag", evmKey: generatePrivateKey() });
  await expect(
    client.createPaymentPayload({
      x402Version: 2,
      resource: { url: "https://example.test" },
      accepts: [{ ...baseReq, asset: "0x0000000000000000000000000000000000000001" }],
    }),
  ).rejects.toThrow("only default assets or entries");
});

describe("OptimizedSvmScheme", () => {
  afterEach(() => vi.unstubAllGlobals());

  const rpcBlockhash = "11111111111111111111111111111111";
  const hintedBlockhash = "So11111111111111111111111111111111111111112";

  async function buildTransaction(extra: Record<string, unknown>) {
    const rpc = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const { method, id } = (await new Request(input, init).json()) as {
        method: string;
        id: string;
      };
      expect(method).toBe("getLatestBlockhash");
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          context: { slot: 1 },
          value: { blockhash: rpcBlockhash, lastValidBlockHeight: 10 },
        },
      });
    });
    vi.stubGlobal("fetch", rpc);
    const [signer, payee, feePayer] = await Promise.all([
      generateKeyPairSigner(),
      generateKeyPairSigner(),
      generateKeyPairSigner(),
    ]);
    const scheme = new OptimizedSvmScheme(signer);
    const { payload } = await scheme.createPaymentPayload(2, {
      ...solanaReq,
      asset: USDC_MINT,
      payTo: payee.address,
      extra: { feePayer: feePayer.address, ...extra },
    });
    const tx = getTransactionDecoder().decode(Buffer.from(payload.transaction, "base64"));
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (message.version !== 0) throw new Error("Expected a v0 transaction");
    const instructions = message.instructions.map((ix) => ({
      program: message.staticAccounts[ix.programAddressIndex],
      data: Buffer.from(ix.data ?? []),
    }));
    return { message, instructions, rpc };
  }

  it("preserves the v0 transfer layout and random nonce without seller hints", async () => {
    const { message, instructions, rpc } = await buildTransaction({});
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(message.lifetimeToken).toBe(rpcBlockhash);
    expect(message.staticAccounts).toHaveLength(8);
    expect(instructions.map((ix) => ix.program)).toEqual([
      "ComputeBudget111111111111111111111111111111",
      "ComputeBudget111111111111111111111111111111",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    ]);
    expect(instructions.slice(0, 3).map((ix) => ix.data.toString("hex"))).toEqual([
      "02204e0000",
      "030100000000000000",
      "0ca08601000000000006",
    ]);
    expect(instructions[3].data.toString()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("uses the seller blockhash without contacting RPC", async () => {
    const { rpc, message } = await buildTransaction({
      recentBlockhash: hintedBlockhash,
      lastValidBlockHeight: 99,
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(message.lifetimeToken).toBe(hintedBlockhash);
  });

  it("uses a fresh nonce for empty seller memos sharing a blockhash", async () => {
    const extra = { memo: "", recentBlockhash: hintedBlockhash, lastValidBlockHeight: 99 };
    const first = (await buildTransaction(extra)).instructions[3].data.toString();
    const second = (await buildTransaction(extra)).instructions[3].data.toString();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(second).not.toBe(first);
  });

  it("encodes the supplied memo exactly", async () => {
    const memo = "\u00e9".repeat(128);
    const { instructions } = await buildTransaction({ memo });
    expect(instructions[3].data).toEqual(Buffer.from(memo));
  });

  it("rejects a seller memo larger than 256 UTF-8 bytes", async () => {
    await expect(buildTransaction({ memo: `${"\u00e9".repeat(128)}a` })).rejects.toThrow(
      /memo.*256 bytes/,
    );
  });

  it.each([
    { versions: [] },
    { versions: [1] },
  ])("refuses incompatible transaction versions before preparing payment (%j)", async ({
    versions,
  }) => {
    const signer = await generateKeyPairSigner();
    const scheme = new OptimizedSvmScheme(signer);
    await expect(
      scheme.createPaymentPayload(2, {
        ...solanaReq,
        asset: USDC_MINT,
        payTo: signer.address,
        extra: { transactionVersions: versions },
      }),
    ).rejects.toThrow("unsupported_transaction_version");
  });
});

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

  it("maps 'tempo' to eip155:4217", () => {
    expect(networkToCaipPrefix("tempo")).toBe("eip155:4217");
  });

  it("is case-insensitive", () => {
    expect(networkToCaipPrefix("Base")).toBe("eip155:8453");
    expect(networkToCaipPrefix("Tempo")).toBe("eip155:4217");
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

  it("returns only matching requirements for tempo", () => {
    const filter = createNetworkFilter("tempo");
    expect(filter(2, allReqs)).toEqual([tempoReq]);
  });

  it("throws when tempo is unavailable", () => {
    const filter = createNetworkFilter("tempo");
    expect(() => filter(2, [baseReq, solanaReq])).toThrow("Network 'tempo' not accepted");
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

  it("selects tempo when preferred", () => {
    const selector = createNetworkPreference("tempo");
    expect(selector(2, allReqs)).toEqual(tempoReq);
  });

  it("falls back when tempo preference unavailable", () => {
    const selector = createNetworkPreference("tempo");
    expect(selector(2, [baseReq])).toEqual(baseReq);
  });
});

// --- createAddressValidationPolicy ---

describe("createAddressValidationPolicy", () => {
  const policy = createAddressValidationPolicy();

  const validBaseReq = makeReq({
    network: "eip155:8453",
    payTo: "0x2cA6f53D5Fbc89d9a0658AEc0352a453ac991EC1",
  });
  const validSolanaReq = makeReq({
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    payTo: "AepWpq3GQwL8CeKMtZyKtKPa7W91Coygh3ropAJapVdU",
  });
  const malformedSolanaReq = makeReq({
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    payTo: "0x2cA6f53D5Fbc89d9a0658AEc0352a453ac991EC1",
  });
  const malformedEvmReq = makeReq({
    network: "eip155:8453",
    payTo: "AepWpq3GQwL8CeKMtZyKtKPa7W91Coygh3ropAJapVdU",
  });

  it("passes valid EVM and Solana options", () => {
    expect(policy(2, [validBaseReq, validSolanaReq])).toEqual([validBaseReq, validSolanaReq]);
  });

  it("filters out Solana option with EVM payTo", () => {
    expect(policy(2, [validBaseReq, malformedSolanaReq])).toEqual([validBaseReq]);
  });

  it("filters out EVM option with Solana payTo", () => {
    expect(policy(2, [malformedEvmReq, validSolanaReq])).toEqual([validSolanaReq]);
  });

  it("falls back to valid option when first is malformed", () => {
    expect(policy(2, [malformedSolanaReq, validBaseReq])).toEqual([validBaseReq]);
  });

  it("throws with clear message when all options are malformed", () => {
    expect(() => policy(2, [malformedSolanaReq])).toThrow(
      "Server returned only malformed payment options",
    );
    expect(() => policy(2, [malformedSolanaReq])).toThrow("Solana option has EVM-format payTo");
  });

  it("throws listing all malformed reasons when multiple bad options", () => {
    expect(() => policy(2, [malformedSolanaReq, malformedEvmReq])).toThrow(
      "payTo addresses don't match the advertised networks",
    );
  });

  it("passes through unknown network types unchanged", () => {
    const unknownReq = makeReq({ network: "cosmos:cosmoshub-4", payTo: "cosmos1xyz" });
    expect(policy(2, [unknownReq])).toEqual([unknownReq]);
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
