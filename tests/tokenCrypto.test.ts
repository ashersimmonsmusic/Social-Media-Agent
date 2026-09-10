import { describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = { SOCIAL_TOKEN_KEY: "b".repeat(64) };
vi.mock("../src/config/env.js", () => ({ env: envState }));

const { encryptToken, decryptToken, tokenHint, MissingTokenKeyError } = await import("../src/lib/tokenCrypto.js");

describe("token encryption", () => {
  it("round-trips a token", () => {
    const token = "EAAB-a-very-long-instagram-access-token";
    expect(decryptToken(encryptToken(token))).toBe(token);
  });

  it("never stores the token in readable form", () => {
    const token = "EAAB-secret-value";
    const stored = encryptToken(token);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain("secret");
  });

  it("produces different ciphertext each time, so equal tokens aren't linkable", () => {
    expect(encryptToken("same-token")).not.toBe(encryptToken("same-token"));
  });

  it("fails loudly if a stored row has been tampered with", () => {
    const stored = encryptToken("original");
    const [iv, tag, ciphertext] = stored.split(":");
    const flipped = Buffer.from(ciphertext!, "base64");
    flipped[0] ^= 0xff;
    expect(() => decryptToken([iv, tag, flipped.toString("base64")].join(":"))).toThrow();
  });

  it("rejects a malformed stored value", () => {
    expect(() => decryptToken("not-the-right-shape")).toThrow(/iv:tag:ciphertext/);
  });

  it("accepts a base64 key as well as hex", () => {
    envState.SOCIAL_TOKEN_KEY = Buffer.alloc(32, 7).toString("base64");
    expect(decryptToken(encryptToken("works"))).toBe("works");
    envState.SOCIAL_TOKEN_KEY = "b".repeat(64);
  });

  it("explains what to do when the key is missing", () => {
    envState.SOCIAL_TOKEN_KEY = undefined;
    expect(() => encryptToken("x")).toThrow(MissingTokenKeyError);
    expect(() => encryptToken("x")).toThrow(/openssl rand -hex 32/);
    envState.SOCIAL_TOKEN_KEY = "b".repeat(64);
  });

  it("rejects a key that isn't 32 bytes", () => {
    envState.SOCIAL_TOKEN_KEY = "tooshort";
    expect(() => encryptToken("x")).toThrow(/32 bytes/);
    envState.SOCIAL_TOKEN_KEY = "b".repeat(64);
  });

  it("hints at a token without revealing it", () => {
    expect(tokenHint("abcdefghijkl")).toBe("…ijkl");
    expect(tokenHint("ab")).toBe("****");
  });
});
