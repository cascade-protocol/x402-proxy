import { describe, expect, it } from "vitest";
import { checkSeller, meronaChain, verdictFromDecision } from "./trust-guard.js";

const PAYTO = "0x1111111111111111111111111111111111111111";

function stubFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(status === 200 ? JSON.stringify(body) : null, {
      status,
    })) as unknown as typeof fetch;
}

describe("meronaChain", () => {
  it("maps supported CAIP-2 ids", () => {
    expect(meronaChain("eip155:8453")).toBe("base");
    expect(meronaChain("eip155:137")).toBe("polygon");
    expect(meronaChain("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe("solana");
  });
  it("accepts plain names", () => {
    expect(meronaChain("base")).toBe("base");
  });
  it("returns undefined for uncovered networks", () => {
    expect(meronaChain("eip155:999")).toBeUndefined();
    expect(meronaChain(undefined)).toBeUndefined();
  });
});

describe("verdictFromDecision", () => {
  it("maps decisions", () => {
    expect(verdictFromDecision("FAIL")).toBe("deny");
    expect(verdictFromDecision("UNCERTAIN")).toBe("review");
    expect(verdictFromDecision("PASS")).toBe("allow");
    expect(verdictFromDecision(undefined)).toBe("allow");
  });
});

describe("checkSeller", () => {
  it("denies on FAIL", async () => {
    const r = await checkSeller(PAYTO, "eip155:8453", {
      fetchImpl: stubFetch(200, { decision: "FAIL", reason_code: "charged_unserved" }),
    });
    expect(r.verdict).toBe("deny");
    expect(r.reason).toBe("charged_unserved");
  });

  it("reviews on UNCERTAIN", async () => {
    const r = await checkSeller(PAYTO, "eip155:8453", {
      fetchImpl: stubFetch(200, { decision: "UNCERTAIN", null_reason: "insufficient_signal" }),
    });
    expect(r.verdict).toBe("review");
  });

  it("allows on PASS", async () => {
    const r = await checkSeller(PAYTO, "eip155:8453", {
      fetchImpl: stubFetch(200, { decision: "PASS", reason_code: "grade_pass" }),
    });
    expect(r.verdict).toBe("allow");
  });

  it("fails soft (allow) when merona errors", async () => {
    const r = await checkSeller(PAYTO, "eip155:8453", { fetchImpl: stubFetch(500, null) });
    expect(r.verdict).toBe("allow");
  });

  it("fails soft (allow) when fetch throws", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await checkSeller(PAYTO, "eip155:8453", { fetchImpl: throwing });
    expect(r.verdict).toBe("allow");
  });

  it("no-ops (allow) on uncovered network without calling out", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await checkSeller(PAYTO, "eip155:999", { fetchImpl: spy });
    expect(r.verdict).toBe("allow");
    expect(called).toBe(false);
  });
});
