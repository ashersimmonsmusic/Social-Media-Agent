import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  video: { id: "v1" } as { id: string } | null,
  clips: [] as Record<string, unknown>[],
};
const captionCalls: { brief: string; whatItShows?: string }[] = [];

vi.mock("../src/config/env.js", () => ({ env: {} }));
vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    sourceVideo: { findUnique: async () => state.video, findFirst: async () => state.video },
    clip: {
      findFirst: async ({ where }: { where: { rank: number } }) =>
        state.clips.find((clip) => clip.rank === where.rank) ?? null,
      findMany: async () => state.clips.filter((clip) => clip.decision === "SELECTED"),
    },
  },
}));
vi.mock("../src/modules/content/caption.service.js", () => ({
  draftCaptions: async (input: { brief: string; whatItShows?: string }) => {
    captionCalls.push(input);
    return [
      { hook: "Four notes.", body: "Three days.", hashtags: ["bristol"] },
      { hook: "A second angle.", body: "Also true.", hashtags: [] },
    ];
  },
  renderCaption: (option: { hook: string; body: string }) => `${option.hook}\n\n${option.body}`,
}));

const { captionsForClip, readyToPublish, ClipNotReadyError } = await import(
  "../src/modules/clipping/publish.service.js"
);

const clip = (over: Record<string, unknown> = {}) => ({
  rank: 1,
  title: "Why I almost quit music",
  transcript: "There was a point where I nearly packed it in.",
  reason: "A complete story.",
  startSeconds: 100,
  endSeconds: 147,
  decision: "PENDING",
  assetId: "asset-1",
  ...over,
});

beforeEach(() => {
  state.video = { id: "v1" };
  state.clips = [clip()];
  captionCalls.length = 0;
});

describe("captionsForClip", () => {
  it("writes from what is actually said, not from the title", async () => {
    // The transcript is better material than anything he would retype.
    const result = await captionsForClip(1);

    expect(result.rendered).toHaveLength(2);
    expect(captionCalls[0]!.whatItShows).toContain("nearly packed it in");
    expect(captionCalls[0]!.brief).toContain("Why I almost quit music");
  });

  it("tells the caption writer how long the clip is", async () => {
    await captionsForClip(1);
    expect(captionCalls[0]!.brief).toContain("47-second");
  });

  it("refuses rather than inventing when there is no transcript", async () => {
    state.clips = [clip({ transcript: "   " })];
    await expect(captionsForClip(1)).rejects.toThrow(ClipNotReadyError);
    await expect(captionsForClip(1)).rejects.toThrow(/nothing to write from/);
  });

  it("says so when the clip does not exist", async () => {
    await expect(captionsForClip(99)).rejects.toThrow(/can't find clip 99/);
  });

  it("says so when nothing has been analysed at all", async () => {
    state.video = null;
    await expect(captionsForClip(1)).rejects.toThrow(ClipNotReadyError);
  });
});

describe("readyToPublish", () => {
  it("separates what can go out today from what still needs cutting", async () => {
    // A selected clip with no asset ranked below the few rendered up front.
    // Leaving it out of the list would be less use than saying why.
    state.clips = [
      clip({ rank: 1, decision: "SELECTED", assetId: "asset-1" }),
      clip({ rank: 7, decision: "SELECTED", assetId: null, title: "Ranked lower" }),
    ];

    const { ready, needCutting } = await readyToPublish();

    expect(ready.map((c) => c.rank)).toEqual([1]);
    expect(needCutting.map((c) => c.rank)).toEqual([7]);
  });

  it("returns nothing when he has selected nothing", async () => {
    state.clips = [clip({ decision: "PENDING" })];
    const { ready, needCutting } = await readyToPublish();
    expect(ready).toHaveLength(0);
    expect(needCutting).toHaveLength(0);
  });

  it("copes with no analysed video rather than throwing", async () => {
    state.video = null;
    expect(await readyToPublish()).toEqual({ ready: [], needCutting: [] });
  });
});
