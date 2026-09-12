import { beforeEach, describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  PUBLIC_BASE_URL: "https://bot.up.railway.app",
  SOCIAL_TOKEN_KEY: "f".repeat(64),
  ADMIN_API_KEY: "admin",
  GOOGLE_DRIVE_FOLDER_ID: undefined,
};
vi.mock("../src/config/env.js", () => ({ env: envState }));
vi.mock("../src/db/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/modules/audit/audit.service.js", () => ({ recordAudit: async () => {} }));

const { authorisationUrl, createState, verifyState, DRIVE_SCOPES, GoogleNotConfiguredError } = await import(
  "../src/modules/oauth/google.service.js"
);

describe("authorisationUrl", () => {
  beforeEach(() => {
    envState.GOOGLE_CLIENT_ID = "client-id";
    envState.PUBLIC_BASE_URL = "https://bot.up.railway.app";
  });

  it("asks only for read access to Drive", () => {
    const scope = new URL(authorisationUrl()).searchParams.get("scope")!;
    expect(scope).toContain("drive.readonly");
    // Anything broader could delete his footage.
    expect(scope).not.toContain("auth/drive ");
    expect(DRIVE_SCOPES.some((s) => s.endsWith("/drive"))).toBe(false);
  });

  it("requests offline access and consent, or the grant dies in an hour", () => {
    const params = new URL(authorisationUrl()).searchParams;
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
  });

  it("points back at this app's callback", () => {
    expect(new URL(authorisationUrl()).searchParams.get("redirect_uri")).toBe(
      "https://bot.up.railway.app/oauth/google/callback",
    );
  });

  it("says what's missing rather than building a broken link", () => {
    envState.GOOGLE_CLIENT_ID = undefined;
    expect(() => authorisationUrl()).toThrow(GoogleNotConfiguredError);
  });
});

describe("oauth state", () => {
  it("accepts a state it just issued", () => {
    expect(verifyState(createState())).toBe(true);
  });

  it("rejects a forged or empty state, so the public callback can't be driven by anyone", () => {
    expect(verifyState("")).toBe(false);
    expect(verifyState("nonsense")).toBe(false);
    expect(verifyState(`${Date.now()}.deadbeef`)).toBe(false);
  });

  it("rejects a state older than its window", () => {
    const stale = Date.now() - 20 * 60 * 1000;
    const [, signature] = createState().split(".");
    expect(verifyState(`${stale}.${signature}`)).toBe(false);
  });

  it("rejects a tampered timestamp carrying a valid-looking signature", () => {
    const [issued, signature] = createState().split(".");
    expect(verifyState(`${Number(issued) + 1000}.${signature}`)).toBe(false);
  });
});
