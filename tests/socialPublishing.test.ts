import { beforeEach, describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = {
  DRY_RUN: true,
  META_GRAPH_API_VERSION: "v21.0",
  SOCIAL_TOKEN_KEY: "a".repeat(64),
};
const audits: { action: string }[] = [];

vi.mock("../src/config/env.js", () => ({ env: envState }));
vi.mock("../src/modules/audit/audit.service.js", () => ({
  recordAudit: async (entry: { action: string }) => {
    audits.push(entry);
  },
}));

const { InstagramAdapter, PublishError } = await import("../src/modules/social/instagram.adapter.js");

const account = { platform: "INSTAGRAM" as const, platformAccountId: "17841400000000000", accessToken: "secret-token" };
const adapter = new InstagramAdapter();

describe("InstagramAdapter.validate", () => {
  it("accepts a normal caption with a public https image", () => {
    const result = adapter.validate({ caption: "New single out now 🎧", mediaUrl: "https://example.com/a.jpg" });
    expect(result).toEqual({ ok: true, problems: [] });
  });

  it("rejects a text-only post, because Instagram has no such thing", () => {
    const result = adapter.validate({ caption: "Just some words" });
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/no text-only post/i);
  });

  it("rejects media that isn't publicly fetchable over https", () => {
    expect(adapter.validate({ caption: "x", mediaUrl: "/app/uploads/a.jpg" }).ok).toBe(false);
    expect(adapter.validate({ caption: "x", mediaUrl: "http://example.com/a.jpg" }).ok).toBe(false);
  });

  it("rejects an empty caption", () => {
    expect(adapter.validate({ caption: "   ", mediaUrl: "https://example.com/a.jpg" }).ok).toBe(false);
  });

  it("enforces the 2200-character caption limit", () => {
    const result = adapter.validate({ caption: "a".repeat(2201), mediaUrl: "https://example.com/a.jpg" });
    expect(result.problems.join(" ")).toMatch(/2200/);
  });

  it("enforces the 30-hashtag limit", () => {
    const caption = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
    const result = adapter.validate({ caption, mediaUrl: "https://example.com/a.jpg" });
    expect(result.problems.join(" ")).toMatch(/31 hashtags/);
  });
});

describe("InstagramAdapter.publish under DRY_RUN", () => {
  beforeEach(() => {
    envState.DRY_RUN = true;
    audits.length = 0;
    vi.restoreAllMocks();
  });

  it("makes no network call and records what would have happened", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await adapter.publish(account, {
      caption: "Testing the pipeline",
      mediaUrl: "https://example.com/a.jpg",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.platformPostId).toMatch(/^dry-run-/);
    expect(audits.map((a) => a.action)).toContain("social.publish_dry_run");
  });

  it("still refuses an invalid post rather than dry-running it", async () => {
    await expect(adapter.publish(account, { caption: "no image" })).rejects.toThrow(PublishError);
  });
});

describe("InstagramAdapter.publish for real", () => {
  beforeEach(() => {
    envState.DRY_RUN = false;
    audits.length = 0;
    vi.restoreAllMocks();
  });

  it("creates a media container then publishes it", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      calls.push(String(url));
      const id = String(url).includes("media_publish") ? "post-999" : "container-123";
      return new Response(JSON.stringify({ id }), { status: 200 });
    });

    const result = await adapter.publish(account, { caption: "Live now", mediaUrl: "https://example.com/a.jpg" });

    expect(calls[0]).toContain(`${account.platformAccountId}/media`);
    expect(calls[1]).toContain(`${account.platformAccountId}/media_publish`);
    expect(result).toEqual({ platformPostId: "post-999", dryRun: false });
    expect(audits.map((a) => a.action)).toContain("social.published");
  });

  it("surfaces a Graph API error message instead of failing silently", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Media URL unreachable", code: 9004 } }), { status: 400 }),
    );

    await expect(
      adapter.publish(account, { caption: "x", mediaUrl: "https://example.com/missing.jpg" }),
    ).rejects.toThrow(/Media URL unreachable/);
  });

  it("does not report success when the API returns no post id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      adapter.publish(account, { caption: "x", mediaUrl: "https://example.com/a.jpg" }),
    ).rejects.toThrow(/no container id/i);
  });
});
