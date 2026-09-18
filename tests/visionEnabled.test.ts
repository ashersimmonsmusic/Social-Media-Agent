import { describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = {
  AI_MODEL_STRATEGY: "claude-opus-5",
  AI_MODEL_FAST: "claude-haiku-4-5",
  AI_MONTHLY_BUDGET_USD: 50,
};
const seen: { model: string; attachments: number }[] = [];

vi.mock("../src/config/env.js", () => ({ env: envState }));
vi.mock("../src/ai/budget.js", () => ({ checkAiBudget: async () => {} }));
vi.mock("../src/ai/usage.js", () => ({ recordUsage: async () => {} }), { virtual: true });
vi.mock("../src/db/prisma.js", () => ({ prisma: { aIUsageLog: { create: async () => ({}) } } }));
vi.mock("../src/lib/logger.js", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));

const { AIService } = await import("../src/ai/AIService.js");

const provider = {
  name: "test",
  generate: async (model: string, _prompt: string, options: { attachments?: unknown[] }) => {
    seen.push({ model, attachments: options.attachments?.length ?? 0 });
    return {
      text: "ok",
      provider: "test",
      model,
      promptTokens: 1,
      completionTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  },
  converse: async () => ({ text: "", provider: "test", model: "", promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
};

describe("looking at images", () => {
  it("runs a VISION call instead of refusing it", async () => {
    // A Phase 1 stub outlived the feature it was holding a place for, and
    // silently disabled subject-aware cropping, clip descriptions and naming.
    const service = new AIService(provider as never);

    const result = await service.generate("VISION", "what is in these", {
      attachments: [{ kind: "image", mediaType: "image/jpeg", data: Buffer.from("x") }],
    });

    expect(result.text).toBe("ok");
    expect(seen.at(-1)).toEqual({ model: "claude-haiku-4-5", attachments: 1 });
  });

  it("uses the cheap model, since looking at stills is not strategy", async () => {
    const service = new AIService(provider as never);
    await service.generate("VISION", "x");
    expect(seen.at(-1)!.model).toBe("claude-haiku-4-5");
  });
});
