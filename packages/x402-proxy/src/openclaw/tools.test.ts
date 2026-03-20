import { describe, expect, it } from "vitest";
import type { PaymentInfo } from "../handler.js";
import { paymentAmount } from "./tools.js";

const payment = (amount: string | undefined): PaymentInfo => ({
  protocol: "x402",
  network: undefined,
  payTo: undefined,
  amount,
  asset: undefined,
});

describe("paymentAmount", () => {
  it("converts raw USDC base units to human-readable amount", () => {
    expect(paymentAmount(payment("50000"))).toBeCloseTo(0.05);
    expect(paymentAmount(payment("1000000"))).toBe(1);
  });

  it("returns undefined for missing payment", () => {
    expect(paymentAmount(undefined)).toBeUndefined();
  });

  it("returns undefined for missing amount", () => {
    expect(paymentAmount(payment(undefined))).toBeUndefined();
  });

  it("returns undefined for non-numeric amount", () => {
    expect(paymentAmount(payment("not-a-number"))).toBeUndefined();
  });

  it("handles zero amount", () => {
    expect(paymentAmount(payment("0"))).toBe(0);
  });
});
