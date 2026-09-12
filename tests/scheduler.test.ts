import { beforeEach, describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = { DRY_RUN: true, SOCIAL_TOKEN_KEY: "e".repeat(64) };

interface Row {
  id: string;
  caption: string;
  assetId: string | null;
  status: string;
  scheduledFor: Date | null;
  failureReason?: string;
  platformPostId?: string;
  socialAccount: { platform: "INSTAGRAM" };
}

let rows: Row[] = [];
const published: string[] = [];

vi.mock("../src/config/env.js", () => ({ env: envState }));
vi.mock("../src/modules/audit/audit.service.js", () => ({ recordAudit: async () => {} }));
vi.mock("../src/lib/signedMedia.js", () => ({ signedMediaUrl: (id: string) => `https://example.com/media/${id}` }));
vi.mock("../src/modules/social/social.service.js", () => ({
  NoAccountError: class NoAccountError extends Error {},
  activeAccountFor: async () => ({
    id: "acc_1",
    connected: { platform: "INSTAGRAM", platformAccountId: "1784", accessToken: "t" },
  }),
  adapterFor: () => ({
    publish: async (_a: unknown, post: { caption: string }) => {
      published.push(post.caption);
      return { platformPostId: `p_${published.length}`, dryRun: true };
    },
  }),
}));
vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    socialPost: {
      findFirst: async ({ where }: { where: { status: string; scheduledFor: { lte: Date } } }) =>
        rows
          .filter((r) => r.status === where.status && r.scheduledFor && r.scheduledFor <= where.scheduledFor.lte)
          .sort((a, b) => a.scheduledFor!.getTime() - b.scheduledFor!.getTime())[0] ?? null,
      updateMany: async ({ where, data }: { where: { id: string; status: string }; data: { status: string } }) => {
        // Mirrors the conditional update the real claim relies on.
        const row = rows.find((r) => r.id === where.id && r.status === where.status);
        if (!row) return { count: 0 };
        row.status = data.status;
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "new", ...data }),
      findMany: async () => rows,
    },
  },
}));

const { runDuePosts } = await import("../src/modules/social/scheduler.service.js");

function row(partial: Partial<Row> & { id: string }): Row {
  return {
    caption: `caption ${partial.id}`,
    assetId: null,
    status: "SCHEDULED",
    scheduledFor: new Date(Date.now() - 60_000),
    socialAccount: { platform: "INSTAGRAM" },
    ...partial,
  };
}

describe("runDuePosts", () => {
  beforeEach(() => {
    rows = [];
    published.length = 0;
  });

  it("publishes a post whose time has come", async () => {
    rows = [row({ id: "a" })];
    expect(await runDuePosts()).toBe(1);
    expect(published).toEqual(["caption a"]);
    expect(rows[0]!.status).toBe("PUBLISHED");
  });

  it("leaves a post whose time hasn't come", async () => {
    rows = [row({ id: "a", scheduledFor: new Date(Date.now() + 3_600_000) })];
    expect(await runDuePosts()).toBe(0);
    expect(published).toEqual([]);
    expect(rows[0]!.status).toBe("SCHEDULED");
  });

  it("publishes every due post in one pass, oldest first", async () => {
    rows = [
      row({ id: "later", scheduledFor: new Date(Date.now() - 60_000) }),
      row({ id: "earlier", scheduledFor: new Date(Date.now() - 600_000) }),
    ];
    expect(await runDuePosts()).toBe(2);
    expect(published).toEqual(["caption earlier", "caption later"]);
  });

  it("never publishes the same post twice, even across overlapping runs", async () => {
    rows = [row({ id: "a" })];
    await Promise.all([runDuePosts(), runDuePosts()]);
    expect(published).toEqual(["caption a"]);
  });

  it("abandons a post that missed its slot rather than posting it late", async () => {
    rows = [row({ id: "stale", scheduledFor: new Date(Date.now() - 5 * 60 * 60 * 1000) })];
    await runDuePosts();
    expect(published).toEqual([]);
    expect(rows[0]!.status).toBe("FAILED");
    expect(rows[0]!.failureReason).toMatch(/missed its slot/i);
  });

  it("records why a publish failed instead of retrying forever", async () => {
    const social = await import("../src/modules/social/social.service.js");
    vi.spyOn(social, "adapterFor").mockReturnValue({
      platform: "INSTAGRAM",
      validate: () => ({ ok: true, problems: [] }),
      publish: async () => {
        throw new Error("Instagram said no");
      },
    });

    rows = [row({ id: "a" })];
    await runDuePosts();
    expect(rows[0]!.status).toBe("FAILED");
    expect(rows[0]!.failureReason).toBe("Instagram said no");
    vi.restoreAllMocks();
  });

  it("does nothing when the queue is empty", async () => {
    expect(await runDuePosts()).toBe(0);
  });
});
