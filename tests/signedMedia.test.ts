import { describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = {
  SOCIAL_TOKEN_KEY: "c".repeat(64),
  PUBLIC_BASE_URL: "https://asher-bot.up.railway.app",
};
vi.mock("../src/config/env.js", () => ({ env: envState }));

const { signedMediaUrl, verifyMediaSignature, MediaUrlUnavailableError } = await import(
  "../src/lib/signedMedia.js"
);

function partsOf(url: string) {
  const parsed = new URL(url);
  return {
    assetId: parsed.pathname.split("/").pop()!,
    expires: Number(parsed.searchParams.get("expires")),
    signature: parsed.searchParams.get("signature")!,
  };
}

describe("signedMediaUrl", () => {
  it("builds an absolute https URL Instagram can fetch", () => {
    const url = signedMediaUrl("asset_123");
    expect(url).toMatch(/^https:\/\/asher-bot\.up\.railway\.app\/media\/asset_123\?/);
  });

  it("round-trips its own signature", () => {
    const { assetId, expires, signature } = partsOf(signedMediaUrl("asset_123"));
    expect(verifyMediaSignature(assetId, expires, signature)).toBe(true);
  });

  it("tolerates a trailing slash on the base URL", () => {
    envState.PUBLIC_BASE_URL = "https://asher-bot.up.railway.app/";
    expect(signedMediaUrl("a")).not.toContain("//media");
    envState.PUBLIC_BASE_URL = "https://asher-bot.up.railway.app";
  });

  it("explains which variable is missing rather than failing obscurely", () => {
    envState.PUBLIC_BASE_URL = undefined;
    expect(() => signedMediaUrl("a")).toThrow(MediaUrlUnavailableError);
    expect(() => signedMediaUrl("a")).toThrow(/PUBLIC_BASE_URL/);
    envState.PUBLIC_BASE_URL = "https://asher-bot.up.railway.app";

    envState.SOCIAL_TOKEN_KEY = undefined;
    expect(() => signedMediaUrl("a")).toThrow(/SOCIAL_TOKEN_KEY/);
    envState.SOCIAL_TOKEN_KEY = "c".repeat(64);
  });
});

describe("verifyMediaSignature", () => {
  it("rejects a signature for a different asset, so one link can't fetch another", () => {
    const { expires, signature } = partsOf(signedMediaUrl("asset_123"));
    expect(verifyMediaSignature("asset_456", expires, signature)).toBe(false);
  });

  it("rejects an expired link", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    // Sign a past timestamp the same way a stale URL would carry it.
    const { signature } = partsOf(signedMediaUrl("asset_123", -120));
    expect(verifyMediaSignature("asset_123", past, signature)).toBe(false);
  });

  it("rejects a tampered expiry, so a link can't be extended by editing the URL", () => {
    const { assetId, expires, signature } = partsOf(signedMediaUrl("asset_123"));
    expect(verifyMediaSignature(assetId, expires + 86_400, signature)).toBe(false);
  });

  it("rejects a garbage or empty signature", () => {
    const { assetId, expires } = partsOf(signedMediaUrl("asset_123"));
    expect(verifyMediaSignature(assetId, expires, "")).toBe(false);
    expect(verifyMediaSignature(assetId, expires, "deadbeef")).toBe(false);
  });

  it("rejects a non-numeric expiry", () => {
    const { assetId, signature } = partsOf(signedMediaUrl("asset_123"));
    expect(verifyMediaSignature(assetId, Number.NaN, signature)).toBe(false);
  });

  it("rejects a signature made under a different key", () => {
    const { assetId, expires, signature } = partsOf(signedMediaUrl("asset_123"));
    envState.SOCIAL_TOKEN_KEY = "d".repeat(64);
    expect(verifyMediaSignature(assetId, expires, signature)).toBe(false);
    envState.SOCIAL_TOKEN_KEY = "c".repeat(64);
  });
});
