import { beforeEach, describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = { VIDEO_RETENTION_DAYS: 7, VIDEO_WORK_DIR: "/tmp/video-test-root" };
const state = {
  candidates: [] as Record<string, unknown>[],
  lastWhere: null as Record<string, unknown> | null,
};
const deleted: string[] = [];
const updated: { id: string; data: Record<string, unknown> }[] = [];

vi.mock("../src/config/env.js", () => ({ env: envState }));
vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    asset: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        state.lastWhere = args.where;
        return state.candidates;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updated.push({ id: where.id, data });
        return data;
      },
    },
  },
}));
vi.mock("../src/storage/index.js", () => ({
  storage: {
    delete: async (key: string) => {
      if (key === "missing") throw new Error("already gone");
      deleted.push(key);
    },
  },
}));
vi.mock("../src/modules/audit/audit.service.js", () => ({ recordAudit: async () => {} }));

const { purgeSpentVideoBytes } = await import("../src/modules/video/retention.js");

beforeEach(() => {
  state.candidates = [];
  state.lastWhere = null;
  deleted.length = 0;
  updated.length = 0;
  envState.VIDEO_RETENTION_DAYS = 7;
});

describe("purgeSpentVideoBytes", () => {
  it("deletes the file and keeps the row", async () => {
    state.candidates = [
      { id: "a1", filename: "clip-vertical.mp4", storageKey: "key-1", metadata: { sizeBytes: 20_000_000 } },
    ];

    const result = await purgeSpentVideoBytes();

    expect(deleted).toEqual(["key-1"]);
    expect(result).toEqual({ purged: 1, freedBytes: 20_000_000 });
    // The row survives so the post history still shows what went out.
    expect(updated[0]!.data.storageKey).toBe("");
    expect((updated[0]!.data.metadata as Record<string, unknown>).purgedAt).toBeTruthy();
  });

  it("only looks at published video, never anything still queued", async () => {
    await purgeSpentVideoBytes();

    const where = state.lastWhere!;
    expect(where.assetType).toBe("VIDEO");
    expect(JSON.stringify(where.socialPosts)).toContain("PUBLISHED");
    // An asset can carry several posts; one being spent says nothing about the rest.
    const excluded = JSON.stringify(where.NOT);
    expect(excluded).toContain("SCHEDULED");
    expect(excluded).toContain("AWAITING_APPROVAL");
    expect(excluded).toContain("DRAFT");
  });

  it("keeps anything published inside the retention window", async () => {
    await purgeSpentVideoBytes(7);
    const posted = state.lastWhere!.socialPosts as { some: { publishedAt: { lt: Date } } };
    const cutoff = posted.some.publishedAt.lt;

    const daysAgo = (Date.now() - cutoff.getTime()) / 86_400_000;
    expect(daysAgo).toBeGreaterThan(6.9);
    expect(daysAgo).toBeLessThan(7.1);
  });

  it("clears the row even when the file has already gone", async () => {
    // A missing file is the state we wanted; failing here would retry forever.
    state.candidates = [{ id: "a1", filename: "x.mp4", storageKey: "missing", metadata: {} }];

    const result = await purgeSpentVideoBytes();

    expect(result.purged).toBe(1);
    expect(updated[0]!.data.storageKey).toBe("");
  });

  it("preserves the rest of the metadata, so why it looks that way survives", async () => {
    state.candidates = [
      {
        id: "a1",
        filename: "x.mp4",
        storageKey: "key-1",
        metadata: { sizeBytes: 1000, reframeStrategy: "blur", reframeReason: "subject moves" },
      },
    ];

    await purgeSpentVideoBytes();

    const metadata = updated[0]!.data.metadata as Record<string, unknown>;
    expect(metadata.reframeStrategy).toBe("blur");
    expect(metadata.reframeReason).toBe("subject moves");
  });

  it("does nothing when there is nothing spent", async () => {
    const result = await purgeSpentVideoBytes();
    expect(result).toEqual({ purged: 0, freedBytes: 0 });
    expect(deleted).toHaveLength(0);
  });
});

describe("stale working directories", () => {
  it("are swept before the purge, since they take space nothing accounts for", async () => {
    // A render killed by a deploy leaves its source behind with no owner. On a
    // small volume two of those is the whole disk, and the symptom is later
    // renders refusing for space nothing appears to be using.
    const { sweepStaleWorkDirs } = await import("../src/modules/video/ffmpeg.js");
    await expect(sweepStaleWorkDirs()).resolves.toBeTypeOf("number");
  });
});
