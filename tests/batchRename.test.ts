import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  videos: [] as { id: string; name: string; sizeBytes: number }[],
  transcriptNames: {} as Record<string, string | null>,
  frameNames: {} as Record<string, string | null>,
  renameFails: new Set<string>(),
  lastAudit: null as { entityId: string; details: unknown } | null,
};
const renames: { fileId: string; name: string }[] = [];
const audits: { action: string; details: unknown }[] = [];
let deepLooks = 0;

vi.mock("../src/config/env.js", () => ({ env: {} }));
vi.mock("../src/lib/logger.js", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    sourceVideo: { updateMany: async () => ({ count: 1 }) },
    auditLog: { findFirst: async () => state.lastAudit },
  },
}));
vi.mock("../src/modules/audit/audit.service.js", () => ({
  recordAudit: async (entry: { action: string; details: unknown }) => {
    audits.push(entry);
  },
}));
vi.mock("../src/modules/drive/drive.service.js", () => ({
  listVideos: async () => state.videos,
  renameFile: async (fileId: string, name: string) => {
    if (state.renameFails.has(fileId)) throw new Error("Google said no");
    renames.push({ fileId, name });
    const original = state.videos.find((video) => video.id === fileId);
    return { from: original?.name ?? fileId, to: `${name}.mp4` };
  },
}));
vi.mock("../src/modules/drive/naming.service.js", () => ({
  looksUnnamed: (name: string) => /^\d+\.|^IMG_/.test(name),
  suggestFromTranscript: async (fileId: string) => state.transcriptNames[fileId] ?? null,
  suggestFromFrames: async (fileId: string) => {
    deepLooks += 1;
    return state.frameNames[fileId] ?? null;
  },
}));

const { planBatchRename, applyBatchRename, undoLastBatchRename, formatPlan } = await import(
  "../src/modules/drive/batchRename.service.js"
);

beforeEach(() => {
  renames.length = 0;
  audits.length = 0;
  deepLooks = 0;
  state.renameFails.clear();
  state.lastAudit = null;
  state.videos = [
    { id: "a", name: "00066.mp4", sizeBytes: 100_000_000 },
    { id: "b", name: "IMG_4821.mp4", sizeBytes: 200_000_000 },
    { id: "c", name: "Louisiana live set.mp4", sizeBytes: 50_000_000 },
  ];
  state.transcriptNames = { a: "Studio session working out the bridge" };
  state.frameNames = { b: "Rehearsal room wide shot" };
});

describe("planBatchRename", () => {
  it("names the ones it can for free and leaves named files alone", async () => {
    const plan = await planBatchRename();

    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({ from: "00066.mp4", basis: "transcript" });
    expect(plan.skipped).toBe(1);
  });

  it("quotes the download rather than doing it unasked", async () => {
    // A folder of untouched clips is gigabytes of transfer; that is a decision.
    const plan = await planBatchRename();

    expect(plan.needLooking.map((video) => video.id)).toEqual(["b"]);
    expect(deepLooks).toBe(0);
    // 200,000,000 bytes is 191 MiB, which is what every file tool shows.
    expect(formatPlan(plan)).toContain("191MB of downloading");
  });

  it("looks properly only when asked", async () => {
    const plan = await planBatchRename(true);

    expect(deepLooks).toBe(1);
    expect(plan.entries.map((entry) => entry.basis)).toEqual(["transcript", "frames"]);
  });

  it("caps how many files it will download in one command", async () => {
    state.videos = Array.from({ length: 12 }, (_, i) => ({
      id: `f${i}`,
      name: `0000${i}.mp4`,
      sizeBytes: 100_000_000,
    }));
    state.transcriptNames = {};
    state.frameNames = Object.fromEntries(state.videos.map((video) => [video.id, `Name for ${video.id}`]));

    const plan = await planBatchRename(true);

    expect(plan.entries.length).toBeLessThanOrEqual(5);
    expect(plan.needLooking.length).toBeGreaterThan(0);
  });

  it("keeps going when one file cannot be read", async () => {
    state.transcriptNames = {};
    state.frameNames = { a: null, b: "Rehearsal room wide shot" };

    const plan = await planBatchRename(true);

    expect(plan.entries.map((entry) => entry.to)).toEqual(["Rehearsal room wide shot"]);
    expect(plan.needLooking.map((video) => video.id)).toContain("a");
  });
});

describe("applyBatchRename", () => {
  const entries = [
    { fileId: "a", from: "00066.mp4", to: "Studio session", basis: "transcript" as const },
    { fileId: "b", from: "IMG_4821.mp4", to: "Rehearsal room", basis: "frames" as const },
  ];

  it("renames them and records the batch as one thing", async () => {
    const result = await applyBatchRename(entries);

    expect(result.renamed).toHaveLength(2);
    // One audit entry, because fifteen individual undos is not an undo.
    expect(audits.filter((audit) => audit.action === "drive.batch_renamed")).toHaveLength(1);
  });

  it("stores every previous name, which is what makes an undo possible", async () => {
    await applyBatchRename(entries);

    const details = audits[0]!.details as { renames: { from: string }[] };
    expect(details.renames.map((rename) => rename.from)).toEqual(["00066.mp4", "IMG_4821.mp4"]);
  });

  it("carries on past one failure and reports it by name", async () => {
    state.renameFails.add("a");

    const result = await applyBatchRename(entries);

    expect(result.renamed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ from: "00066.mp4" });
    expect(result.failed[0]!.reason).toContain("Google said no");
  });

  it("records nothing when everything failed, so there is no empty undo", async () => {
    state.renameFails.add("a");
    state.renameFails.add("b");

    await applyBatchRename(entries);
    expect(audits.filter((audit) => audit.action === "drive.batch_renamed")).toHaveLength(0);
  });
});

describe("undoLastBatchRename", () => {
  it("puts every file back to what it was called", async () => {
    state.lastAudit = {
      entityId: "batch-1",
      details: {
        renames: [
          { fileId: "a", from: "00066.mp4", to: "Studio session" },
          { fileId: "b", from: "IMG_4821.mp4", to: "Rehearsal room" },
        ],
      },
    };

    const result = await undoLastBatchRename();

    expect(result).toEqual({ restored: 2, failed: 0 });
    expect(renames.map((rename) => rename.name)).toEqual(["00066", "IMG_4821"]);
  });

  it("says so when there is nothing to undo", async () => {
    expect(await undoLastBatchRename()).toBeNull();
  });

  it("restores what it can when one file will not revert", async () => {
    state.renameFails.add("a");
    state.lastAudit = {
      entityId: "batch-1",
      details: {
        renames: [
          { fileId: "a", from: "00066.mp4", to: "Studio session" },
          { fileId: "b", from: "IMG_4821.mp4", to: "Rehearsal room" },
        ],
      },
    };

    expect(await undoLastBatchRename()).toEqual({ restored: 1, failed: 1 });
  });
});
