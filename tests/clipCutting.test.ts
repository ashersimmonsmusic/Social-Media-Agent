import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: {} }));
vi.mock("../src/lib/logger.js", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock("../src/db/prisma.js", () => ({ prisma: { clip: { update: async () => ({}) } } }));
vi.mock("../src/modules/assets/asset.service.js", () => ({ ingestFile: async () => ({ id: "a1" }) }));

const { safeFilename, cuesForClip } = await import("../src/modules/clipping/cut.service.js");
const { formatClip, scoreHighlights } = await import("../src/modules/clipping/review.service.js");
const { formatFinished } = await import("../src/modules/clipping/job.service.js");

describe("safeFilename", () => {
  it("names the file after the content, ranked", () => {
    expect(safeFilename(1, "Why I almost quit music", 42)).toBe("01_Why_I_almost_quit_music_42s.mp4");
  });

  it("strips characters a filesystem would object to", () => {
    const name = safeFilename(2, 'The "biggest" mistake: I/made', 58);
    expect(name).not.toMatch(/["/:]/);
    expect(name).toBe("02_The_biggest_mistake_Imade_58s.mp4");
  });

  it("keeps long titles to a readable length", () => {
    const name = safeFilename(3, "one two three four five six seven eight nine ten", 31);
    expect(name.split("_")).toHaveLength(9); // rank + 7 words + duration
  });

  it("falls back rather than producing a nameless file", () => {
    expect(safeFilename(4, "!!!", 20)).toBe("04_clip_20s.mp4");
  });

  it("pads the rank so a list sorts properly", () => {
    expect(safeFilename(1, "x", 10).startsWith("01_")).toBe(true);
  });
});

describe("cuesForClip", () => {
  const cues = [
    { start: 100, end: 102, text: "one" },
    { start: 103, end: 105, text: "two" },
    { start: 106, end: 108, text: "three" },
    { start: 200, end: 202, text: "far away" },
  ];

  it("re-times cues so zero is the clip's own start", () => {
    // Subtitles are burned into the cut, which begins at zero — not at 100.
    const clipped = cuesForClip(cues, 100, 109);
    expect(clipped[0]).toEqual({ start: 0, end: 2, text: "one" });
    expect(clipped[2]!.start).toBe(6);
  });

  it("leaves out cues outside the clip", () => {
    expect(cuesForClip(cues, 100, 109).map((cue) => cue.text)).not.toContain("far away");
  });

  it("clamps a cue straddling the edge instead of letting it start before zero", () => {
    // A negative start makes ffmpeg ignore the whole line.
    const clipped = cuesForClip(cues, 101, 109);
    expect(clipped[0]!.start).toBe(0);
    expect(clipped.every((cue) => cue.start >= 0)).toBe(true);
  });

  it("clamps a cue running past the end of the clip", () => {
    const clipped = cuesForClip(cues, 100, 104);
    expect(clipped.every((cue) => cue.end <= 4)).toBe(true);
  });

  it("drops a cue left with no duration after clamping", () => {
    expect(cuesForClip(cues, 102, 103)).toEqual([]);
  });
});

describe("scoreHighlights", () => {
  it("names the weakest number, which is what he is trading away", () => {
    const line = scoreHighlights({ hook: 95, story: 90, independence: 40, audio: 80 });
    expect(line).toContain("weakest: independence 40");
    expect(line).toContain("strongest: hook 95");
  });

  it("says nothing when there is no breakdown", () => {
    expect(scoreHighlights({})).toBe("");
  });
});

describe("formatClip", () => {
  const clip = {
    rank: 1,
    title: "Why I almost quit music",
    score: 94,
    scores: { hook: 96, independence: 90, audio: 70 },
    startSeconds: 872.4,
    endSeconds: 919.7,
    reason: "A complete story with a payoff.",
    transcript: "There was a point where I nearly packed it in.",
    topic: "career",
    suggestedPlatforms: ["instagram", "youtube"],
    decision: "PENDING",
    assetId: "asset-1",
  };

  it("leads with rank, title and the numbers that matter", () => {
    const text = formatClip(clip);
    expect(text).toContain("01 — WHY I ALMOST QUIT MUSIC");
    expect(text).toContain("94/100");
    expect(text).toContain("47s");
    // 919.7s rounds to 15:20 — the brief’s example said 15:19, the arithmetic says otherwise.
    expect(text).toContain("14:32→15:20");
  });

  it("quotes what is said, so it can be judged without watching", () => {
    expect(formatClip(clip)).toContain("nearly packed it in");
  });

  it("says which platforms suit it rather than assuming all of them", () => {
    expect(formatClip(clip)).toContain("Suits: instagram, youtube");
  });

  it("marks a decision once one is made", () => {
    expect(formatClip({ ...clip, decision: "SELECTED" })).toContain("✓ selected");
    expect(formatClip({ ...clip, decision: "REJECTED" })).toContain("✗ rejected");
  });

  it("says plainly when a clip has not been cut yet", () => {
    expect(formatClip({ ...clip, assetId: null })).toContain("Not cut yet");
  });

  it("truncates a long transcript rather than flooding the message", () => {
    const text = formatClip({ ...clip, transcript: "word ".repeat(200) });
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(900);
  });
});

describe("formatFinished", () => {
  const clips = [
    { rank: 1, title: "Why I almost quit music", score: 94, startSeconds: 100, endSeconds: 147 },
    { rank: 2, title: "The biggest mistake I made", score: 91, startSeconds: 200, endSeconds: 258 },
  ];

  it("leads with what was found and how good it is", () => {
    const text = formatFinished("studio-session.mp4", clips, 2);
    expect(text).toContain("studio-session.mp4");
    expect(text).toContain("01 — Why I almost quit music — 94/100 · 47s");
    expect(text).toContain("/clips");
  });

  it("says so when nothing rendered, rather than implying there is something to watch", () => {
    expect(formatFinished("x.mp4", clips, 0)).toContain("None of them rendered");
  });
});
