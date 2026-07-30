import { describe, expect, it } from "vitest";

import { createCounterpartyPolicy } from "./resolve-wallet.js";

const SOL = "BJGdsDXJFy63eCAnX3UmGfShp8BuqbtkTfcamyRGr7VQ";
const SOL2 = "34w53UkhfBBmVLBcphD1M4dRhbBTQaLLbnRfyTeXzc5m";
const EVM = "0x6B386D954052D4d5dCB7F066624DAF11d6Ed191a";

// Minimal shape the policy touches. The real type carries more fields.
function req(payTo: string, network = "solana:mainnet") {
  return { payTo, network, amount: "50000", asset: "USDC" } as never;
}

describe("createCounterpartyPolicy", () => {
  it("is a no-op when no lists are configured", () => {
    const policy = createCounterpartyPolicy({});
    const reqs = [req(SOL), req(SOL2)];
    expect(policy(1, reqs)).toHaveLength(2);
  });

  it("drops a denied counterparty but keeps the rest", () => {
    const policy = createCounterpartyPolicy({ deny: [SOL2] });
    const kept = policy(1, [req(SOL), req(SOL2)]);
    expect(kept).toHaveLength(1);
    expect((kept[0] as { payTo: string }).payTo).toBe(SOL);
  });

  it("throws when every option is denied (nothing gets signed)", () => {
    const policy = createCounterpartyPolicy({ deny: [SOL] });
    expect(() => policy(1, [req(SOL)])).toThrow(/No acceptable counterparty/);
  });

  it("names the refused address so the operator can act", () => {
    const policy = createCounterpartyPolicy({ deny: [SOL] });
    expect(() => policy(1, [req(SOL)])).toThrow(new RegExp(SOL));
  });

  it("allow list restricts to exactly its members", () => {
    const policy = createCounterpartyPolicy({ allow: [SOL] });
    const kept = policy(1, [req(SOL), req(SOL2)]);
    expect(kept).toHaveLength(1);
    expect((kept[0] as { payTo: string }).payTo).toBe(SOL);
  });

  it("throws when nothing satisfies the allow list", () => {
    const policy = createCounterpartyPolicy({ allow: [SOL] });
    expect(() => policy(1, [req(SOL2)])).toThrow(/not in allow list/);
  });

  it("deny wins over allow for the same address", () => {
    // Contradictory config must resolve to the safer reading.
    const policy = createCounterpartyPolicy({ allow: [SOL], deny: [SOL] });
    expect(() => policy(1, [req(SOL)])).toThrow(/denied/);
  });

  it("matches EVM addresses case-insensitively", () => {
    const policy = createCounterpartyPolicy({ deny: [EVM.toLowerCase()] });
    expect(() => policy(1, [req(EVM, "eip155:8453")])).toThrow(/No acceptable counterparty/);
  });

  it("matches Solana addresses case-sensitively (base58 is case-significant)", () => {
    // Lower-casing a base58 key yields a DIFFERENT key; it must not match.
    const policy = createCounterpartyPolicy({ deny: [SOL.toLowerCase()] });
    expect(policy(1, [req(SOL)])).toHaveLength(1);
  });

  it("empty request list is passed through, not treated as a refusal", () => {
    const policy = createCounterpartyPolicy({ deny: [SOL] });
    expect(policy(1, [])).toHaveLength(0);
  });
});
