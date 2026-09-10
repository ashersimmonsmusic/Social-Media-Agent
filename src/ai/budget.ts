import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";

/**
 * Thrown instead of making a paid API call once the month's budget is gone.
 * Carries the figures so the Telegram layer can say where things stand.
 */
export class BudgetExceededError extends Error {
  constructor(
    readonly spend: number,
    readonly budget: number,
  ) {
    super(
      `This month's AI budget is spent — $${spend.toFixed(2)} of $${budget.toFixed(2)}. ` +
        `Raise AI_MONTHLY_BUDGET_USD in Railway to carry on, or wait for the 1st.`,
    );
    this.name = "BudgetExceededError";
  }
}

/** UTC so the month boundary doesn't shift with the server's timezone. */
export function startOfMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getMonthToDateAiSpend(): Promise<number> {
  const { _sum } = await prisma.aIUsageLog.aggregate({
    _sum: { estimatedCostUsd: true },
    where: { createdAt: { gte: startOfMonthUtc() } },
  });
  return _sum.estimatedCostUsd ?? 0;
}

export interface SpendByTask {
  taskType: string;
  calls: number;
  costUsd: number;
}

export async function getSpendBreakdown(): Promise<SpendByTask[]> {
  const rows = await prisma.aIUsageLog.groupBy({
    by: ["taskType"],
    where: { createdAt: { gte: startOfMonthUtc() } },
    _sum: { estimatedCostUsd: true },
    _count: { _all: true },
  });
  return rows
    .map((row) => ({
      taskType: row.taskType,
      calls: row._count._all,
      costUsd: row._sum.estimatedCostUsd ?? 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

/** Share of the budget at which Asher gets a one-off heads-up. */
const WARN_FRACTION = 0.8;

/** Months already warned about, so the warning fires once rather than every message. */
const warnedMonths = new Set<string>();

/**
 * The brake. Throws once spend reaches the budget so no further paid call is
 * made, and otherwise returns a warning the first time spend crosses
 * WARN_FRACTION in a month. Setting AI_MONTHLY_BUDGET_USD to 0 disables both.
 */
export async function checkAiBudget(): Promise<string | null> {
  const budget = env.AI_MONTHLY_BUDGET_USD;
  if (budget <= 0) return null;

  const spend = await getMonthToDateAiSpend();
  if (spend >= budget) throw new BudgetExceededError(spend, budget);

  if (spend >= budget * WARN_FRACTION) {
    const month = startOfMonthUtc().toISOString();
    if (!warnedMonths.has(month)) {
      warnedMonths.add(month);
      return `Heads up — you've used $${spend.toFixed(2)} of your $${budget.toFixed(2)} AI budget this month.`;
    }
  }
  return null;
}
