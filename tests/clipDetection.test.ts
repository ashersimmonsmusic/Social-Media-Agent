import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: {} }));
vi.mock("../src/ai/AIService.js", () => ({ aiService: { generate: async () => ({ text: "{}" }) } }));
vi.mock("../src/lib/logger.js", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));

const { parseCandidates, parseScores, dedupeByOverlap, MIN_CLIP_SECONDS, MAX_CLIP_SECONDS } = await import(
  "../src/modules/clipping/detect.service.js"
);
const { clippingBrief, PRINCIPLE, REJECT, CRITERIA } = await import("../src/modules/clipping/craft.js");

/** Five minutes of speech, a phrase every two seconds. */
const cues = Array.from({ length: 150 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.8, text: `phrase ${i}` }));

describe("the clipping brief", () => {
  it("leads on the thing that kills most candidates", () => {
    expect(PRINCIPLE).toMatch(/never seen the video/i);
    expect(clippingBrief()).toContain(PRINCIPLE);
  });

  it("carries every rejection rule, so none can be quietly dropped", () => {
    const brief = clippingBrief();
    for (const rule of REJECT) expect(brief).toContain(rule);
  });

  it("refuses to frame scores as a prediction of performance", () => {
    expect(clippingBrief()).toMatch(/not a prediction/i);
  });

  it("scores independence, which is what makes a clip standalone", () => {
    expect(CRITERIA.map(([key]) => key)).toContain("independence");
  });
});

describe("parseCandidates", () => {
  it("snaps a round timestamp onto real speech", () => {
    // A model gives round numbers; they land mid-word.
    const found = parseCandidates(
      '{"candidates":[{"start":41,"end":80,"title":"A real moment","reason":"stands alone","topic":"studio"}]}',
      cues,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.startSeconds).toBeLessThan(43);
    expect(found[0]!.transcript).toContain("phrase");
  });

  it("drops a candidate too short to be a clip", () => {
    expect(parseCandidates('{"candidates":[{"start":10,"end":14,"title":"Too short"}]}', cues)).toEqual([]);
  });

  it("drops a candidate longer than Instagram will publish", () => {
    // Dropped here rather than at cut time, so nothing is spent scoring it.
    expect(parseCandidates('{"candidates":[{"start":0,"end":200,"title":"Too long"}]}', cues)).toEqual([]);
  });

  it("drops one with no title, since the list would be unreadable", () => {
    expect(parseCandidates('{"candidates":[{"start":10,"end":40,"title":"  "}]}', cues)).toEqual([]);
  });

  it("drops one whose end precedes its start", () => {
    expect(parseCandidates('{"candidates":[{"start":80,"end":40,"title":"Backwards"}]}', cues)).toEqual([]);
  });

  it("treats an empty list as a real answer, not a failure", () => {
    expect(parseCandidates('{"candidates":[]}', cues)).toEqual([]);
  });

  it("survives junk rather than throwing mid-analysis", () => {
    expect(parseCandidates("not json", cues)).toEqual([]);
    expect(parseCandidates('{"candidates":"nope"}', cues)).toEqual([]);
  });

  it("keeps lengths inside the range the brief asks for", () => {
    const found = parseCandidates('{"candidates":[{"start":20,"end":70,"title":"Good length"}]}', cues);
    const duration = found[0]!.endSeconds - found[0]!.startSeconds;
    expect(duration).toBeGreaterThanOrEqual(MIN_CLIP_SECONDS);
    expect(duration).toBeLessThanOrEqual(MAX_CLIP_SECONDS);
  });
});

describe("dedupeByOverlap", () => {
  const make = (start: number, end: number, title: string) => ({
    startSeconds: start,
    endSeconds: end,
    title,
    reason: "",
    transcript: "",
  });

  it("removes the same moment proposed twice by overlapping windows", () => {
    // This is mechanical, not a judgement — it happens because two windows can
    // both see a moment on their shared seam.
    const kept = dedupeByOverlap([make(100, 140, "First"), make(102, 139, "Second")]);
    expect(kept).toHaveLength(1);
  });

  it("keeps two moments that merely touch", () => {
    expect(dedupeByOverlap([make(100, 140, "One"), make(138, 180, "Two")])).toHaveLength(2);
  });

  it("keeps moments that do not overlap at all", () => {
    expect(dedupeByOverlap([make(0, 40, "One"), make(100, 140, "Two")])).toHaveLength(2);
  });

  it("returns them in the order they occur", () => {
    const kept = dedupeByOverlap([make(200, 240, "Later"), make(0, 40, "Earlier")]);
    expect(kept.map((clip) => clip.title)).toEqual(["Earlier", "Later"]);
  });
});

describe("parseScores", () => {
  const candidates = [
    { startSeconds: 10, endSeconds: 50, title: "One", reason: "proposed", transcript: "a" },
    { startSeconds: 60, endSeconds: 100, title: "Two", reason: "proposed", transcript: "b" },
  ];

  it("attaches scores to the right candidate", () => {
    const scored = parseScores(
      '{"clips":[{"index":2,"score":88,"scores":{"hook":90},"reason":"strong","platforms":["tiktok"]}]}',
      candidates,
    );
    expect(scored).toHaveLength(1);
    expect(scored[0]!.title).toBe("Two");
    expect(scored[0]!.suggestedPlatforms).toEqual(["tiktok"]);
  });

  it("drops a candidate the ranking pass chose not to keep", () => {
    // Dropping a weaker duplicate is the point of the second pass.
    const scored = parseScores('{"clips":[{"index":1,"score":70}]}', candidates);
    expect(scored).toHaveLength(1);
    expect(scored[0]!.title).toBe("One");
  });

  it("ignores an index that matches no candidate", () => {
    expect(parseScores('{"clips":[{"index":99,"score":90}]}', candidates)).toEqual([]);
  });

  it("clamps a score outside 0-100", () => {
    const scored = parseScores('{"clips":[{"index":1,"score":150,"scores":{"hook":-20}}]}', candidates);
    expect(scored[0]!.score).toBe(100);
    expect(scored[0]!.scores.hook).toBe(0);
  });

  it("fills every criterion, so the breakdown is never half-empty", () => {
    const scored = parseScores('{"clips":[{"index":1,"score":80,"scores":{"hook":90}}]}', candidates);
    for (const [key] of CRITERIA) expect(scored[0]!.scores[key]).toBeTypeOf("number");
  });

  it("ignores a platform it cannot publish to", () => {
    const scored = parseScores('{"clips":[{"index":1,"score":80,"platforms":["instagram","myspace"]}]}', candidates);
    expect(scored[0]!.suggestedPlatforms).toEqual(["instagram"]);
  });

  it("keeps the original reason when the ranking pass gives none", () => {
    expect(parseScores('{"clips":[{"index":1,"score":80}]}', candidates)[0]!.reason).toBe("proposed");
  });
});
