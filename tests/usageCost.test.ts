import { describe, expect, it, vi } from "vitest";

const logged: Record<string, unknown>[] = [];

vi.mock("../src/config/env.js", () => ({
  env: {
    AI_MODEL_STRATEGY: "claude-opus-5",
    AI_MODEL_FAST: "claude-haiku-4-5",
    ANTHROPIC_API_KEY: "test-key",
    AI_MONTHLY_BUDGET_USD: 0,
  },
}));
vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    aIUsageLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        logged.push(data);
        return data;
      },
      aggregate: async () => ({ _sum: { estimatedCostUsd: 0 } }),
    },
  },
}));

const { recordUsage } = await import("../src/ai/AIService.js");

describe("recordUsage cost calculation", () => {
  it("prices cache reads at 0.1x and cache writes at 1.25x of input", async () => {
    await recordUsage("CHAT", {
      text: "hi",
      provider: "anthropic",
      model: "claude-opus-5",
      promptTokens: 1_000,
      completionTokens: 100,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 1_000,
    });

    // Opus 5 is $5 in / $25 out per MTok:
    //   uncached input 1000  -> 0.005000
    //   cache read     1000  -> 0.000500  (0.1x)
    //   cache write    1000  -> 0.006250  (1.25x)
    //   output          100  -> 0.002500
    const row = logged.at(-1)!;
    expect(row.estimatedCostUsd).toBeCloseTo(0.01425, 6);
    expect(row.cacheReadTokens).toBe(1_000);
    expect(row.cacheWriteTokens).toBe(1_000);
  });

  it("costs the same as before when nothing is cached", async () => {
    await recordUsage("CHAT", {
      text: "hi",
      provider: "anthropic",
      model: "claude-sonnet-5",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // Sonnet 5 is $2 in / $10 out per MTok.
    expect(logged.at(-1)!.estimatedCostUsd).toBeCloseTo(12, 6);
  });

  it("makes a fully cached prefix an order of magnitude cheaper than an uncached one", async () => {
    await recordUsage("CHAT", {
      text: "x", provider: "anthropic", model: "claude-opus-5",
      promptTokens: 0, completionTokens: 0, cacheReadTokens: 100_000, cacheWriteTokens: 0,
    });
    const cached = logged.at(-1)!.estimatedCostUsd as number;

    await recordUsage("CHAT", {
      text: "x", provider: "anthropic", model: "claude-opus-5",
      promptTokens: 100_000, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    const uncached = logged.at(-1)!.estimatedCostUsd as number;

    expect(cached).toBeCloseTo(uncached * 0.1, 6);
  });
});
