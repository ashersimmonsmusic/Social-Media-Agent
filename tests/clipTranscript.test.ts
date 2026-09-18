import { describe, expect, it } from "vitest";

const { buildWindows, renderCues, snapToSpeech, WINDOW_SECONDS, OVERLAP_SECONDS } = await import(
  "../src/modules/clipping/transcript.js"
);

const cue = (start: number, end: number, text: string) => ({ start, end, text });

/** A minute of speech, one phrase every two seconds. */
const minute = Array.from({ length: 30 }, (_, i) => cue(i * 2, i * 2 + 1.8, `phrase ${i}`));

describe("renderCues", () => {
  it("stamps each line, since that is how a clip gets located", () => {
    expect(renderCues([cue(0, 1, "hello"), cue(65, 66, "later")])).toBe("[00:00] hello\n[01:05] later");
  });
});

describe("buildWindows", () => {
  it("keeps a short transcript in one piece", () => {
    const windows = buildWindows(minute);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.text).toContain("phrase 0");
  });

  it("splits a long transcript into overlapping windows", () => {
    // An hour of speech, far past what fits in one pass.
    const hour = Array.from({ length: 1800 }, (_, i) => cue(i * 2, i * 2 + 1.8, `line ${i}`));
    const windows = buildWindows(hour);

    expect(windows.length).toBeGreaterThan(5);
    // Each window must start before the previous one ended, or a moment on the
    // seam would be invisible to both.
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]!.startSeconds).toBeLessThan(windows[i - 1]!.endSeconds);
    }
  });

  it("overlaps by enough that a plausible clip cannot fall in a seam", () => {
    expect(OVERLAP_SECONDS).toBeGreaterThanOrEqual(90);
    expect(WINDOW_SECONDS).toBeGreaterThan(OVERLAP_SECONDS * 2);
  });

  it("covers the whole transcript to the last word", () => {
    const hour = Array.from({ length: 1800 }, (_, i) => cue(i * 2, i * 2 + 1.8, `line ${i}`));
    const windows = buildWindows(hour);
    expect(windows.at(-1)!.endSeconds).toBeCloseTo(hour.at(-1)!.end, 0);
  });

  it("returns nothing for an empty transcript rather than one empty window", () => {
    expect(buildWindows([])).toEqual([]);
  });
});

describe("snapToSpeech", () => {
  it("moves a round timestamp onto where speech actually starts", () => {
    // A model asked for a time gives a round number, and a round number lands
    // mid-word.
    const snapped = snapToSpeech(minute, 9, 15);
    expect(snapped.start).toBeCloseTo(10 - 0.25, 2);
  });

  it("ends on a finished thought rather than clipping the last word", () => {
    const snapped = snapToSpeech(minute, 10, 15);
    // Last cue starting at or before 15 is the one at 14, ending 15.8.
    expect(snapped.end).toBeCloseTo(15.8 + 0.6, 2);
  });

  it("pads both sides, because cutting on the first phoneme sounds abrupt", () => {
    const snapped = snapToSpeech(minute, 10, 20);
    expect(snapped.start).toBeLessThan(10);
    expect(snapped.end).toBeGreaterThan(20);
  });

  it("never starts before the beginning of the video", () => {
    expect(snapToSpeech(minute, 0, 5).start).toBe(0);
  });

  it("returns the words in the range, for review without watching", () => {
    expect(snapToSpeech(minute, 10, 14).text).toBe("phrase 5 phrase 6 phrase 7");
  });

  it("copes with a request past the end of the transcript", () => {
    const snapped = snapToSpeech(minute, 500, 520);
    expect(snapped.start).toBeGreaterThanOrEqual(0);
    expect(snapped.text).toBeTruthy();
  });
});
