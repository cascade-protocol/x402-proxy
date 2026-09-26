import { calcSpend, readHistory } from "../history.js";

export type SpendLimits = {
  spendLimitDaily?: number;
  spendLimitPerTx?: number;
  historyPath: string;
};

/** Enforce owner-configured spending limits before creating a payment credential. */
export function assertSpendAllowed(amount: number, limits: SpendLimits): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("Invalid payment amount");
  }

  if (limits.spendLimitPerTx !== undefined && amount > limits.spendLimitPerTx) {
    throw new Error(
      `Payment ${amount} USDC exceeds per-transaction limit of ${limits.spendLimitPerTx} USDC`,
    );
  }

  if (limits.spendLimitDaily !== undefined) {
    const spend = calcSpend(readHistory(limits.historyPath));
    if (spend.today >= limits.spendLimitDaily) {
      throw new Error(`Daily spend limit of ${limits.spendLimitDaily} USDC reached`);
    }
    const remaining = limits.spendLimitDaily - spend.today;
    if (amount > remaining) {
      throw new Error(`Payment ${amount} USDC exceeds remaining daily limit of ${remaining} USDC`);
    }
  }
}
