import { beforeEach, describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = {};
const dbState: { account: Record<string, unknown> | null } = { account: null };

vi.mock("../src/config/env.js", () => ({ env: envState }));
vi.mock("../src/db/prisma.js", () => ({
  prisma: { socialAccount: { findFirst: async () => dbState.account } },
}));
vi.mock("../src/lib/tokenCrypto.js", () => ({ decryptToken: (value: string) => `plain:${value}` }));

// Spawning a real ffprobe makes this suite depend on what is installed on the
// machine running it, and on how fast a process starts.
vi.mock("node:child_process", () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out: unknown) => void) =>
    cb(null, { stdout: "ffprobe version 6.1.1", stderr: "" }),
}));

const { checkPostingReadiness, formatReadiness } = await import("../src/modules/social/readiness.js");

function named(readiness: Awaited<ReturnType<typeof checkPostingReadiness>>, name: string) {
  const check = readiness.checks.find((c) => c.name.includes(name));
  if (!check) throw new Error(`no check matching ${name}`);
  return check;
}

beforeEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(envState)) delete envState[key];
  Object.assign(envState, {
    DRY_RUN: false,
    META_GRAPH_API_VERSION: "v21.0",
    SOCIAL_TOKEN_KEY: "k".repeat(64),
    PUBLIC_BASE_URL: "https://app.up.railway.app",
  });
  dbState.account = { platformAccountId: "178414000", accessToken: "cipher" };
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(JSON.stringify({ id: "178414000", username: "ashersimmonsmusic" }), { status: 200 }),
  );
});

describe("checkPostingReadiness", () => {
  it("reports ready when everything is in place and DRY_RUN is off", async () => {
    const readiness = await checkPostingReadiness();
    expect(readiness.checks.every((check) => check.ok)).toBe(true);
    expect(readiness.canPost).toBe(true);
  });

  it("is not ready while DRY_RUN is on, even with everything else set", async () => {
    envState.DRY_RUN = true;
    const readiness = await checkPostingReadiness();
    expect(readiness.checks.every((check) => check.ok)).toBe(true);
    expect(readiness.canPost).toBe(false);
    expect(formatReadiness(readiness)).toMatch(/DRY_RUN is ON/);
  });

  it("catches a missing public address, which otherwise only fails at publish time", async () => {
    envState.PUBLIC_BASE_URL = undefined;
    const readiness = await checkPostingReadiness();
    expect(named(readiness, "Public address").ok).toBe(false);
    expect(named(readiness, "Public address").remedy).toMatch(/PUBLIC_BASE_URL/);
    expect(readiness.canPost).toBe(false);
  });

  it("catches an account that was never linked", async () => {
    dbState.account = null;
    const readiness = await checkPostingReadiness();
    expect(named(readiness, "account linked").ok).toBe(false);
    expect(named(readiness, "account linked").remedy).toMatch(/\/connect/);
  });

  it("does not try the token when there is no key to decrypt it with", async () => {
    envState.SOCIAL_TOKEN_KEY = undefined;
    const readiness = await checkPostingReadiness();
    expect(readiness.checks.some((check) => check.name.includes("still accepts"))).toBe(false);
    expect(named(readiness, "encryption key").ok).toBe(false);
  });

  it("surfaces Meta's own words when the token has stopped working", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: "Session has expired" } }), { status: 400 }),
    );
    const readiness = await checkPostingReadiness();
    expect(named(readiness, "still accepts").ok).toBe(false);
    expect(named(readiness, "still accepts").remedy).toMatch(/Session has expired/);
  });

  it("treats an unreachable Graph API as a failed check rather than throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const readiness = await checkPostingReadiness();
    expect(named(readiness, "still accepts").ok).toBe(false);
  });
});

describe("formatReadiness", () => {
  it("always names the blocker it cannot see", async () => {
    // The account's role on the Meta app is granted outside this system and
    // surfaces only as a refusal at publish time, so a clean list must not read
    // as "nothing can stop this".
    const text = formatReadiness(await checkPostingReadiness());
    expect(text).toMatch(/Instagram Tester/);
    expect(text).toMatch(/manage_access/);
  });

  it("counts what is blocking rather than just listing crosses", async () => {
    envState.PUBLIC_BASE_URL = undefined;
    dbState.account = null;
    const text = formatReadiness(await checkPostingReadiness());
    expect(text).toMatch(/Not ready — 2 things above/);
  });
});
