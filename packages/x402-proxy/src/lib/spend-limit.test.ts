import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendHistory } from "../history.js";
import { assertSpendAllowed } from "./spend-limit.js";

const dirs: string[] = [];

function historyPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "x402-proxy-limit-"));
  dirs.push(dir);
  return path.join(dir, "history.jsonl");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("assertSpendAllowed", () => {
  it("blocks an MPP charge above the per-transaction owner limit", () => {
    expect(() =>
      assertSpendAllowed(1.25, { historyPath: historyPath(), spendLimitPerTx: 1 }),
    ).toThrow("exceeds per-transaction limit");
  });

  it("blocks an MPP charge that would exceed the remaining daily owner limit", () => {
    const file = historyPath();
    appendHistory(file, {
      t: Date.now(),
      ok: true,
      kind: "mpp_payment",
      net: "tempo",
      from: "0xowner",
      amount: 4.5,
      token: "USDC",
    });

    expect(() => assertSpendAllowed(1, { historyPath: file, spendLimitDaily: 5 })).toThrow(
      "exceeds remaining daily limit",
    );
  });

  it("allows an MPP charge within both owner limits", () => {
    expect(() =>
      assertSpendAllowed(0.5, {
        historyPath: historyPath(),
        spendLimitDaily: 5,
        spendLimitPerTx: 1,
      }),
    ).not.toThrow();
  });
});
