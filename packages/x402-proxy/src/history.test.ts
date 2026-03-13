import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendHistory,
  calcSpend,
  explorerUrl,
  formatTxLine,
  HISTORY_KEEP_LINES,
  HISTORY_MAX_LINES,
  readHistory,
  type TxRecord,
} from "./history.js";

// --- calcSpend ---

describe("calcSpend", () => {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const records: TxRecord[] = [
    {
      t: todayStart.getTime() + 1000,
      ok: true,
      kind: "x402_payment",
      net: "eip155:8453",
      from: "0x1",
      amount: 0.05,
      token: "USDC",
    },
    {
      t: todayStart.getTime() + 2000,
      ok: true,
      kind: "x402_payment",
      net: "solana:mainnet",
      from: "abc",
      amount: 0.1,
      token: "USDC",
    },
    {
      t: todayStart.getTime() - 86400000,
      ok: true,
      kind: "x402_payment",
      net: "eip155:8453",
      from: "0x1",
      amount: 1.0,
      token: "USDC",
    },
    {
      t: now,
      ok: false,
      kind: "x402_payment",
      net: "eip155:8453",
      from: "0x1",
      amount: 0.5,
      token: "USDC",
    }, // failed
    {
      t: now,
      ok: true,
      kind: "transfer",
      net: "eip155:8453",
      from: "0x1",
      amount: 0.01,
      token: "ETH",
    }, // not USDC
  ];

  it("sums only successful USDC transactions", () => {
    const spend = calcSpend(records);
    expect(spend.total).toBeCloseTo(1.15, 6);
    expect(spend.count).toBe(3);
  });

  it("separates today from total", () => {
    const spend = calcSpend(records);
    expect(spend.today).toBeCloseTo(0.15, 6);
  });

  it("handles empty records", () => {
    const spend = calcSpend([]);
    expect(spend).toEqual({ today: 0, total: 0, count: 0 });
  });
});

// --- explorerUrl ---

describe("explorerUrl", () => {
  it("returns basescan URL for Base network", () => {
    expect(explorerUrl("eip155:8453", "0xabc")).toBe("https://basescan.org/tx/0xabc");
  });

  it("returns solscan URL for Solana network", () => {
    expect(explorerUrl("solana:mainnet", "abc123")).toBe("https://solscan.io/tx/abc123");
  });
});

// --- formatTxLine ---

describe("formatTxLine", () => {
  const record: TxRecord = {
    t: Date.UTC(2026, 2, 12, 14, 30),
    ok: true,
    kind: "x402_payment",
    net: "eip155:8453",
    from: "0x1",
    amount: 0.05,
    token: "USDC",
    label: "api.example.com",
    tx: "0xdeadbeef1234567890abcdef1234567890abcdef",
  };

  it("includes network shorthand", () => {
    const line = formatTxLine(record);
    expect(line).toContain("base");
  });

  it("includes amount", () => {
    const line = formatTxLine(record);
    expect(line).toContain("0.05 USDC");
  });

  it("includes label", () => {
    const line = formatTxLine(record);
    expect(line).toContain("api.example.com");
  });

  it("shows truncated tx hash in verbose mode", () => {
    const line = formatTxLine(record, { verbose: true });
    expect(line).toContain("0xdeadbeef...abcdef");
  });

  it("hides truncated tx hash in non-verbose mode", () => {
    const line = formatTxLine(record, { verbose: false });
    // The full hash appears in the explorer URL link, but the truncated hash should not
    expect(line).not.toContain("0xdeadbeef...abcdef");
  });

  it("prefixes failed transactions with cross mark", () => {
    const failed = { ...record, ok: false };
    const line = formatTxLine(failed);
    expect(line).toContain("\u2717"); // ✗
  });
});

// --- readHistory / appendHistory ---

describe("readHistory + appendHistory", () => {
  let dir: string;
  let historyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "x402-test-"));
    historyPath = join(dir, "history.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty array for missing file", () => {
    expect(readHistory(historyPath)).toEqual([]);
  });

  it("roundtrips a record through append and read", () => {
    const record: TxRecord = {
      t: Date.now(),
      ok: true,
      kind: "x402_payment",
      net: "eip155:8453",
      from: "0x1",
    };
    appendHistory(historyPath, record);
    const records = readHistory(historyPath);
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe("x402_payment");
  });

  it("skips malformed lines", () => {
    writeFileSync(
      historyPath,
      'not json\n{"t":1,"kind":"x402_payment","ok":true,"net":"x","from":"y"}\n',
    );
    const records = readHistory(historyPath);
    expect(records).toHaveLength(1);
  });

  it("truncates history when exceeding max lines", () => {
    // Truncation heuristic uses file size (HISTORY_MAX_LINES * 200 bytes).
    // Each record must be ~200+ bytes to trigger it.
    const padding = "x".repeat(180);
    const lines: string[] = [];
    for (let i = 0; i < HISTORY_MAX_LINES + 10; i++) {
      lines.push(
        JSON.stringify({
          t: i,
          ok: true,
          kind: "x402_payment",
          net: "x",
          from: "y",
          label: padding,
        }),
      );
    }
    writeFileSync(historyPath, `${lines.join("\n")}\n`);

    // Appending triggers truncation
    appendHistory(historyPath, {
      t: 99999,
      ok: true,
      kind: "x402_payment",
      net: "x",
      from: "y",
      label: padding,
    });

    const content = readFileSync(historyPath, "utf-8").trimEnd().split("\n");
    expect(content.length).toBeLessThanOrEqual(HISTORY_KEEP_LINES + 1);
  });
});
