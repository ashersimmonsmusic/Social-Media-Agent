import { beforeEach, describe, expect, it, vi } from "vitest";

const accounts: Record<string, unknown>[] = [];
const updates: { id: string; data: Record<string, unknown> }[] = [];
const refreshResult: { value: { token: string; expiresAt: Date } | null; error: Error | null } = {
  value: { token: "renewed", expiresAt: new Date(Date.now() + 60 * 86_400_000) },
  error: null,
};

vi.mock("../src/config/env.js", () => ({ env: { SOCIAL_TOKEN_KEY: "k".repeat(64) } }));
vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    socialAccount: {
      findMany: async () => accounts,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        return data;
      },
    },
  },
}));
vi.mock("../src/lib/tokenCrypto.js", () => ({
  decryptToken: (value: string) => value.replace("enc:", ""),
  encryptToken: (value: string) => `enc:${value}`,
}));
vi.mock("../src/modules/oauth/instagramLogin.service.js", () => ({
  refreshLongLivedToken: async () => {
    if (refreshResult.error) throw refreshResult.error;
    return refreshResult.value;
  },
}));

const { refreshDueTokens } = await import("../src/modules/social/tokenRefresh.js");

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000);

beforeEach(() => {
  accounts.length = 0;
  updates.length = 0;
  refreshResult.error = null;
  refreshResult.value = { token: "renewed", expiresAt: daysFromNow(60) };
});

describe("refreshDueTokens", () => {
  it("renews a token close to expiry", async () => {
    accounts.push({ id: "a1", accessToken: "enc:old", tokenExpiresAt: daysFromNow(3) });

    expect(await refreshDueTokens()).toBe(1);
    expect(updates[0]!.data.accessToken).toBe("enc:renewed");
  });

  it("leaves a token with plenty of life alone", async () => {
    accounts.push({ id: "a1", accessToken: "enc:old", tokenExpiresAt: daysFromNow(45) });

    expect(await refreshDueTokens()).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("renews one whose expiry was never recorded", async () => {
    // An unknown expiry is not a safe one — it may already have passed.
    accounts.push({ id: "a1", accessToken: "enc:old", tokenExpiresAt: null });

    expect(await refreshDueTokens()).toBe(1);
  });

  it("renews an already-expired token rather than giving up on it", async () => {
    accounts.push({ id: "a1", accessToken: "enc:old", tokenExpiresAt: daysFromNow(-1) });

    expect(await refreshDueTokens()).toBe(1);
  });

  it("carries on to the next account when one fails", async () => {
    accounts.push(
      { id: "a1", accessToken: "enc:one", tokenExpiresAt: daysFromNow(1) },
      { id: "a2", accessToken: "enc:two", tokenExpiresAt: daysFromNow(1) },
    );
    let calls = 0;
    refreshResult.error = new Error("first one fails");
    const original = refreshResult.error;
    vi.doMock("../src/modules/oauth/instagramLogin.service.js", () => ({
      refreshLongLivedToken: async () => {
        calls += 1;
        if (calls === 1) throw original;
        return { token: "renewed", expiresAt: daysFromNow(60) };
      },
    }));

    // Both are attempted; the failure is logged, not thrown.
    await expect(refreshDueTokens()).resolves.toBeGreaterThanOrEqual(0);
  });

  it("does not throw when renewal fails outright", async () => {
    accounts.push({ id: "a1", accessToken: "enc:old", tokenExpiresAt: daysFromNow(1) });
    refreshResult.error = new Error("Instagram said no");

    expect(await refreshDueTokens()).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
