import { describe, expect, it } from "vitest";

// env.ts validates the whole environment on import, so satisfy the required
// vars before loading it.
process.env.DATABASE_URL = "postgresql://test/test";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_ALLOWED_CHAT_ID = "1";
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.ADMIN_API_KEY = "test-admin";

const { sanitizeModelId } = await import("../src/config/env.js");

describe("sanitizeModelId", () => {
  it("leaves a correct model id alone", () => {
    expect(sanitizeModelId("claude-opus-5", "fallback")).toBe("claude-opus-5");
    expect(sanitizeModelId("claude-haiku-4-5-20251001", "fallback")).toBe("claude-haiku-4-5-20251001");
  });

  it("strips a pasted KEY= prefix", () => {
    expect(sanitizeModelId("AI_MODEL_STRATEGY=claude-opus-5", "fallback")).toBe("claude-opus-5");
    expect(sanitizeModelId("AI_MODEL_FAST=claude-haiku-4-5", "fallback")).toBe("claude-haiku-4-5");
  });

  it("trims whitespace and wrapping quotes", () => {
    expect(sanitizeModelId("  claude-sonnet-5  ", "fallback")).toBe("claude-sonnet-5");
    expect(sanitizeModelId('"claude-sonnet-5"', "fallback")).toBe("claude-sonnet-5");
    expect(sanitizeModelId('"AI_MODEL_STRATEGY=claude-opus-5"', "fallback")).toBe("claude-opus-5");
  });

  it("falls back when the value is blank", () => {
    expect(sanitizeModelId("", "claude-opus-5")).toBe("claude-opus-5");
    expect(sanitizeModelId("   ", "claude-opus-5")).toBe("claude-opus-5");
    expect(sanitizeModelId("AI_MODEL_STRATEGY=", "claude-opus-5")).toBe("claude-opus-5");
  });
});
