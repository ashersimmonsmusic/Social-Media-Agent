import { beforeEach, describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = { SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined };
vi.mock("../src/config/env.js", () => ({ env: envState }));

const { formatStats } = await import("../src/modules/analytics/analytics.service.js");
const { isSupabaseConfigured, selectRows, SupabaseNotConfiguredError } = await import(
  "../src/modules/analytics/supabase.client.js"
);

const base = {
  posts: { published: 12, scheduled: 2, failed: 0, thisMonth: 3 },
  library: { assets: 40, unused: 11, knowledgeItems: 25 },
  spendUsd: 4.2,
  unavailable: [] as string[],
};

describe("formatStats", () => {
  it("reports the figures it has", () => {
    const out = formatStats(base);
    expect(out).toContain("12 published (3 this month)");
    expect(out).toContain("2 scheduled");
    expect(out).toContain("$4.20");
  });

  it("mentions failures only when there are some", () => {
    expect(formatStats(base)).not.toMatch(/failed/i);
    expect(formatStats({ ...base, posts: { ...base.posts, failed: 2 } })).toMatch(/2 failed/);
  });

  it("shows audience and revenue when Supabase answered", () => {
    const out = formatStats({
      ...base,
      audience: { subscribers: 340, newThisMonth: 18 },
      revenue: { paidGbp: 127.5, orders: 9 },
    });
    expect(out).toContain("340 newsletter subscriber(s)");
    expect(out).toContain("£127.50 across 9 paid order(s)");
  });

  it("omits audience entirely rather than showing a misleading zero", () => {
    const out = formatStats({ ...base, unavailable: ["Subscribers and sales — set SUPABASE_URL…"] });
    expect(out).not.toMatch(/subscriber\(s\)/);
    expect(out).toContain("Couldn't read:");
  });

  it("always says what it cannot see, so streams aren't assumed covered", () => {
    const out = formatStats(base);
    expect(out).toMatch(/Spotify streams/);
    expect(out).toMatch(/Instagram reach/);
  });
});

describe("supabase client", () => {
  beforeEach(() => {
    envState.SUPABASE_URL = undefined;
    envState.SUPABASE_SERVICE_ROLE_KEY = undefined;
    vi.restoreAllMocks();
  });

  it("is not configured without both values", () => {
    expect(isSupabaseConfigured()).toBe(false);
    envState.SUPABASE_URL = "https://x.supabase.co";
    expect(isSupabaseConfigured()).toBe(false);
    envState.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    expect(isSupabaseConfigured()).toBe(true);
  });

  it("refuses to read rather than reporting zero when unconfigured", async () => {
    await expect(selectRows("newsletter_subscribers", {})).rejects.toThrow(SupabaseNotConfiguredError);
  });

  it("reads the total from the Content-Range header, not the row count", async () => {
    envState.SUPABASE_URL = "https://x.supabase.co";
    envState.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ id: "1" }]), {
        status: 200,
        headers: { "content-range": "0-0/340" },
      }),
    );
    const { total, rows } = await selectRows("newsletter_subscribers", { select: "id", limit: "1" });
    expect(total).toBe(340);
    expect(rows).toHaveLength(1);
  });

  it("surfaces a refusal instead of silently returning nothing", async () => {
    envState.SUPABASE_URL = "https://x.supabase.co";
    envState.SUPABASE_SERVICE_ROLE_KEY = "bad-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"message":"invalid key"}', { status: 401 }));
    await expect(selectRows("purchases", {})).rejects.toThrow(/401/);
  });
});
