import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const HISTORY_MAX_LINES = 1000;
export const HISTORY_KEEP_LINES = 500;

// --- Record type ---

export type TxRecord = {
  t: number;
  ok: boolean;
  kind:
    | "x402_inference"
    | "x402_payment"
    | "mpp_payment"
    | "transfer"
    | "buy"
    | "sell"
    | "mint"
    | "swap";
  net: string;
  from: string;
  to?: string;
  tx?: string;
  amount?: number;
  token?: string;
  label?: string;
  ms?: number;
  error?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  thinking?: string;
  meta?: Record<string, string | number>;
};

function isMeaningfulInferenceRecord(record: TxRecord): boolean {
  if (record.kind !== "x402_inference") return true;
  if (!record.ok) return true;
  return (
    record.amount != null ||
    record.model != null ||
    record.inputTokens != null ||
    record.outputTokens != null ||
    record.tx != null
  );
}

// --- File operations ---

export function appendHistory(historyPath: string, record: TxRecord): void {
  try {
    mkdirSync(dirname(historyPath), { recursive: true });
    appendFileSync(historyPath, `${JSON.stringify(record)}\n`);
    if (existsSync(historyPath)) {
      const stat = statSync(historyPath);
      if (stat.size > HISTORY_MAX_LINES * 200) {
        const lines = readFileSync(historyPath, "utf-8").trimEnd().split("\n");
        if (lines.length > HISTORY_MAX_LINES) {
          writeFileSync(historyPath, `${lines.slice(-HISTORY_KEEP_LINES).join("\n")}\n`);
        }
      }
    }
  } catch {
    // History is non-critical - never break the caller
  }
}

export function readHistory(historyPath: string): TxRecord[] {
  try {
    if (!existsSync(historyPath)) return [];
    const content = readFileSync(historyPath, "utf-8").trimEnd();
    if (!content) return [];
    return content.split("\n").flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.t !== "number" || typeof parsed.kind !== "string") return [];
        const record = parsed as TxRecord;
        return isMeaningfulInferenceRecord(record) ? [record] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

// --- Spend aggregation ---

export function calcSpend(records: TxRecord[]): {
  today: number;
  total: number;
  count: number;
} {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  let today = 0;
  let total = 0;
  let count = 0;
  for (const r of records) {
    if (!r.ok || r.amount == null) continue;
    if (r.token !== "USDC") continue;
    total += r.amount;
    count++;
    if (r.t >= todayMs) today += r.amount;
  }
  return { today, total, count };
}

// --- Formatting ---

export function formatUsdcValue(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    useGrouping: false,
    minimumFractionDigits: 0,
    maximumFractionDigits: 12,
  }).format(amount);
}

export function formatAmount(amount: number, token: string): string {
  if (token === "USDC") return `${formatUsdcValue(amount)} USDC`;
  if (token === "SOL") return `${amount} SOL`;
  return `${amount} ${token}`;
}

const KIND_LABELS: Record<TxRecord["kind"], string> = {
  x402_inference: "inference",
  x402_payment: "payment",
  mpp_payment: "mpp payment",
  transfer: "transfer",
  buy: "buy",
  sell: "sell",
  mint: "mint",
  swap: "swap",
};

export function explorerUrl(net: string, tx: string): string {
  if (net.startsWith("eip155:")) {
    const chainId = net.split(":")[1];
    if (chainId === "4217") return `https://explore.mainnet.tempo.xyz/tx/${tx}`;
    if (chainId === "8453") return `https://basescan.org/tx/${tx}`;
    return `https://basescan.org/tx/${tx}`;
  }
  return `https://solscan.io/tx/${tx}`;
}

/** Strip provider prefix and OpenRouter date suffixes from model IDs.
 *  e.g. "minimax/minimax-m2.5-20260211" -> "minimax-m2.5"
 *       "moonshotai/kimi-k2.5-0127" -> "kimi-k2.5" */
function shortModel(model: string): string {
  const parts = model.split("/");
  const name = parts[parts.length - 1];
  return name.replace(/-\d{6,8}$/, "").replace(/-\d{4}$/, "");
}

export function displayNetwork(net: string): string {
  if (net === "eip155:8453") return "Base";
  if (net === "eip155:4217") return "Tempo";
  if (net.startsWith("eip155:")) return `EVM (${net.split(":")[1]})`;
  if (net.startsWith("solana:")) return "Solana";
  return net;
}

function shortNetwork(net: string): string {
  if (net === "eip155:8453") return "base";
  if (net === "eip155:4217") return "tempo";
  if (net.startsWith("eip155:")) return `evm:${net.split(":")[1]}`;
  if (net.startsWith("solana:")) return "sol";
  return net;
}

export function formatTxLine(r: TxRecord, opts?: { verbose?: boolean }): string {
  const time = new Date(r.t).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  const timeStr = r.tx ? `[${time}](${explorerUrl(r.net, r.tx)})` : time;
  const action =
    r.kind === "x402_inference" && r.model ? shortModel(r.model) : (KIND_LABELS[r.kind] ?? r.kind);
  const parts = [action];
  if (r.label) parts.push(r.label);
  if (r.ok && r.amount != null && r.token) {
    parts.push(formatAmount(r.amount, r.token));
  } else if (r.ok && r.kind === "sell" && r.meta?.pct != null) {
    parts.push(`${r.meta.pct}%`);
  }
  parts.push(shortNetwork(r.net));
  if (opts?.verbose && r.tx) {
    const short = r.tx.length > 20 ? `${r.tx.slice(0, 10)}...${r.tx.slice(-6)}` : r.tx;
    parts.push(short);
  }
  const prefix = r.ok ? "" : "✗ ";
  return `  ${timeStr} ${prefix}${parts.join(" · ")}`;
}
