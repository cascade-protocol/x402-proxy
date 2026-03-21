import { buildCommand, type CommandContext } from "@stricli/core";
import pc from "picocolors";
import { calcSpend, formatAmount, formatTxLine, readHistory } from "../history.js";
import { getHistoryPath } from "../lib/config.js";
import { info } from "../lib/output.js";

export const walletHistoryCommand = buildCommand<
  { limit: number; json: boolean },
  [],
  CommandContext
>({
  docs: {
    brief: "Show payment history",
  },
  parameters: {
    flags: {
      limit: {
        kind: "parsed",
        brief: "Number of entries to show",
        parse: Number,
        default: "20",
      },
      json: {
        kind: "boolean",
        brief: "Output raw JSONL",
        default: false,
      },
    },
    positional: { kind: "tuple", parameters: [] },
  },
  func(flags) {
    const historyPath = getHistoryPath();
    const records = readHistory(historyPath);

    if (records.length === 0) {
      console.log(pc.dim("No payment history yet."));
      return;
    }

    if (flags.json) {
      const slice = records.slice(-flags.limit);
      for (const r of slice) {
        process.stdout.write(`${JSON.stringify(r)}\n`);
      }
      return;
    }

    const spend = calcSpend(records);
    const slice = records.slice(-flags.limit);

    console.log();
    info("Payment History");
    console.log();

    for (const r of slice) {
      // formatTxLine returns markdown links - strip them for terminal
      const line = formatTxLine(r).replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // [text](url) -> text
      console.log(line);
    }

    console.log();
    console.log(
      pc.dim(
        `  Today: ${formatAmount(spend.today, "USDC")} | Total: ${formatAmount(spend.total, "USDC")} | ${spend.count} transactions`,
      ),
    );
    console.log();
  },
});
