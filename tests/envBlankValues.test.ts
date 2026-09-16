import { describe, expect, it, vi } from "vitest";

/**
 * Loads the env module fresh against a given process.env, since the real module
 * parses once at import.
 */
async function loadEnv(overrides: Record<string, string | undefined>) {
  const required = {
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_ALLOWED_CHAT_ID: "42",
    ANTHROPIC_API_KEY: "sk-test",
    ADMIN_API_KEY: "admin",
  };
  const previous = { ...process.env };
  process.env = { ...required, ...overrides } as NodeJS.ProcessEnv;
  try {
    // The module parses process.env once at import, so it has to be re-imported
    // rather than re-called.
    vi.resetModules();
    const module = await import("../src/config/env.js");
    return module.env as unknown as Record<string, unknown>;
  } finally {
    process.env = previous;
  }
}

describe("blank environment variables", () => {
  it("treats a variable that exists but is empty as not set", async () => {
    // Railway creates exactly this by saving a name with no value, and an empty
    // string otherwise satisfies z.string() — so the app believes it is set.
    const env = await loadEnv({ PUBLIC_BASE_URL: "" });
    expect(env.PUBLIC_BASE_URL).toBeUndefined();
  });

  it("treats a whitespace-only value as not set", async () => {
    const env = await loadEnv({ GOOGLE_CLIENT_ID: "   " });
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
  });

  it("keeps a real value untouched", async () => {
    const env = await loadEnv({ PUBLIC_BASE_URL: "https://example.up.railway.app" });
    expect(env.PUBLIC_BASE_URL).toBe("https://example.up.railway.app");
  });

  it("falls back to the default when a defaulted variable is blank", async () => {
    // Blanking this should not mean "no dataset" — it should mean "the usual one".
    const env = await loadEnv({ SANITY_DATASET: "", META_GRAPH_API_VERSION: "  " });
    expect(env.SANITY_DATASET).toBe("production");
    expect(env.META_GRAPH_API_VERSION).toBe("v21.0");
  });

  it("still lets a set value override a default", async () => {
    const env = await loadEnv({ SANITY_DATASET: "staging" });
    expect(env.SANITY_DATASET).toBe("staging");
  });
});
