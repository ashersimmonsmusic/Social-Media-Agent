import { beforeEach, describe, expect, it, vi } from "vitest";

const envState = { AI_MONTHLY_BUDGET_USD: 50 };
let monthSpend = 0;

vi.mock("../src/config/env.js", () => ({ env: envState }));
vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    aIUsageLog: {
      aggregate: async () => ({ _sum: { estimatedCostUsd: monthSpend } }),
      groupBy: async () => [
        { taskType: "CHAT", _sum: { estimatedCostUsd: 3 }, _count: { _all: 10 } },
        { taskType: "CAPTION", _sum: { estimatedCostUsd: 7 }, _count: { _all: 4 } },
      ],
    },
  },
}));

/** Fresh module each time — the 80% warning is once-per-month module state. */
async function freshBudget() {
  vi.resetModules();
  return import("../src/ai/budget.js");
}

describe("checkAiBudget", () => {
  beforeEach(() => {
    envState.AI_MONTHLY_BUDGET_USD = 50;
    monthSpend = 0;
  });

  it("stays quiet comfortably under budget", async () => {
    monthSpend = 10;
    const { checkAiBudget } = await freshBudget();
    expect(await checkAiBudget()).toBeNull();
  });

  it("warns on crossing 80%, then stays quiet", async () => {
    monthSpend = 40;
    const { checkAiBudget } = await freshBudget();
    expect(await checkAiBudget()).toContain("$40.00");
    expect(await checkAiBudget()).toBeNull();
  });

  it("throws once spend reaches the budget", async () => {
    monthSpend = 50;
    const { checkAiBudget, BudgetExceededError } = await freshBudget();
    await expect(checkAiBudget()).rejects.toThrow(BudgetExceededError);
  });

  it("keeps throwing past the budget", async () => {
    monthSpend = 120;
    const { checkAiBudget } = await freshBudget();
    await expect(checkAiBudget()).rejects.toThrow(/budget is spent/i);
  });

  it("is disabled entirely when the budget is 0", async () => {
    monthSpend = 999;
    envState.AI_MONTHLY_BUDGET_USD = 0;
    const { checkAiBudget } = await freshBudget();
    expect(await checkAiBudget()).toBeNull();
  });
});

describe("getSpendBreakdown", () => {
  it("returns per-task cost and call counts, dearest first", async () => {
    const { getSpendBreakdown } = await freshBudget();
    expect(await getSpendBreakdown()).toEqual([
      { taskType: "CAPTION", calls: 4, costUsd: 7 },
      { taskType: "CHAT", calls: 10, costUsd: 3 },
    ]);
  });
});
