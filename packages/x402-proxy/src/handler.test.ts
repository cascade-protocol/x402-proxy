import { describe, expect, it } from "vitest";
import { detectProtocols, extractTxSignature } from "./handler.js";

describe("detectProtocols", () => {
  it("detects MPP from WWW-Authenticate Payment header", () => {
    const r = new Response(null, {
      status: 402,
      headers: { "WWW-Authenticate": 'Payment id="abc", realm="test"' },
    });
    expect(detectProtocols(r)).toEqual({ x402: false, mpp: true });
  });

  it("detects x402 from PAYMENT-REQUIRED header", () => {
    const r = new Response(null, {
      status: 402,
      headers: { "PAYMENT-REQUIRED": "eyJ0ZXN0IjoxfQ==" },
    });
    expect(detectProtocols(r)).toEqual({ x402: true, mpp: false });
  });

  it("detects both protocols when both headers present", () => {
    const r = new Response(null, {
      status: 402,
      headers: {
        "WWW-Authenticate": 'Payment id="abc"',
        "PAYMENT-REQUIRED": "eyJ0ZXN0IjoxfQ==",
      },
    });
    expect(detectProtocols(r)).toEqual({ x402: true, mpp: true });
  });

  it("returns both false when neither header present", () => {
    const r = new Response(null, { status: 402 });
    expect(detectProtocols(r)).toEqual({ x402: false, mpp: false });
  });

  it("ignores non-Payment WWW-Authenticate schemes", () => {
    const r = new Response(null, {
      status: 402,
      headers: { "WWW-Authenticate": "Bearer realm=api" },
    });
    expect(detectProtocols(r)).toEqual({ x402: false, mpp: false });
  });

  it("detects X-PAYMENT-REQUIRED variant", () => {
    const r = new Response(null, {
      status: 402,
      headers: { "X-PAYMENT-REQUIRED": "eyJ0ZXN0IjoxfQ==" },
    });
    expect(detectProtocols(r)).toEqual({ x402: true, mpp: false });
  });
});

// --- extractTxSignature ---

describe("extractTxSignature", () => {
  it("extracts reference from MPP Payment-Receipt header", () => {
    const receipt = { method: "tempo", reference: "0xabc123", status: "confirmed" };
    const encoded = Buffer.from(JSON.stringify(receipt)).toString("base64url");
    const r = new Response(null, { headers: { "Payment-Receipt": encoded } });
    expect(extractTxSignature(r)).toBe("0xabc123");
  });

  it("returns undefined for malformed Payment-Receipt", () => {
    const r = new Response(null, { headers: { "Payment-Receipt": "not-valid-base64url" } });
    expect(extractTxSignature(r)).toBeUndefined();
  });

  it("returns undefined when no payment headers present", () => {
    const r = new Response(null);
    expect(extractTxSignature(r)).toBeUndefined();
  });
});
