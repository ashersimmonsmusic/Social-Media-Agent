import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: { AI_MODEL_STRATEGY: "claude-opus-5", AI_MODEL_FAST: "claude-haiku-4-5", ANTHROPIC_API_KEY: "test" },
}));
vi.mock("../src/db/prisma.js", () => ({ prisma: {} }));

const { priceFor } = await import("../src/ai/AIService.js");

describe("priceFor", () => {
  it("prices a model given by its alias", () => {
    expect(priceFor("claude-opus-5")).toEqual({ input: 5, output: 25 });
    expect(priceFor("claude-sonnet-5")).toEqual({ input: 2, output: 10 });
  });

  it("prices a dated model ID the same as its alias", () => {
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual(priceFor("claude-haiku-4-5"));
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual({ input: 1, output: 5 });
  });

  it("falls back to Opus-tier rates for an unrecognised model", () => {
    expect(priceFor("claude-something-unreleased")).toEqual({ input: 5, output: 25 });
  });
});
