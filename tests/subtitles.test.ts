import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: {} }));
vi.mock("../src/lib/logger.js", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));

const { assTime, escapeAssText, wrapCue, buildAss } = await import("../src/modules/video/subtitles.js");
const { groupWordsIntoCues } = await import("../src/modules/transcription/elevenlabs.provider.js");
const { escapeFilterPath, renderArgs } = await import("../src/modules/video/ffmpeg.js");

const probed = { width: 1920, height: 1080, durationSeconds: 30, videoCodec: "h264", hasAudio: true };

describe("assTime", () => {
  it("writes the format ASS expects", () => {
    expect(assTime(0)).toBe("0:00:00.00");
    expect(assTime(65.42)).toBe("0:01:05.42");
    expect(assTime(3661.5)).toBe("1:01:01.50");
  });

  it("never emits a negative time, which would make the file invalid", () => {
    expect(assTime(-5)).toBe("0:00:00.00");
  });

  it("does not round centiseconds up into an invalid 100", () => {
    expect(assTime(1.999)).toBe("0:00:01.99");
  });
});

describe("escapeAssText", () => {
  it("neutralises braces, which would otherwise restyle everything after them", () => {
    // A transcript containing a brace would open an override block and silently
    // change the look of the rest of the captions.
    expect(escapeAssText("she said {hello}")).toBe("she said \\{hello\\}");
  });

  it("flattens newlines rather than truncating the line", () => {
    expect(escapeAssText("one\ntwo")).toBe("one two");
  });
});

describe("wrapCue", () => {
  it("leaves a short line alone", () => {
    expect(wrapCue("four notes")).toBe("four notes");
  });

  it("breaks a long line in two", () => {
    expect(wrapCue("took three days and it is only four notes long")).toContain("\\N");
  });

  it("never runs to three lines, which is more than can be read in time", () => {
    const wrapped = wrapCue("a ".repeat(60).trim());
    expect(wrapped.split("\\N")).toHaveLength(2);
  });
});

describe("buildAss", () => {
  it("sizes the canvas to the vertical frame", () => {
    const ass = buildAss([{ start: 0, end: 1, text: "hi" }]);
    expect(ass).toContain("PlayResX: 1080");
    expect(ass).toContain("PlayResY: 1920");
  });

  it("keeps captions clear of the interface at the bottom of a Reel", () => {
    // Instagram covers the lower part of the frame with its own furniture.
    const ass = buildAss([{ start: 0, end: 1, text: "hi" }]);
    const style = ass.split("\n").find((line) => line.startsWith("Style: Caption"))!;
    const marginV = Number(style.split(",").at(-2));
    expect(marginV).toBeGreaterThan(250);
  });

  it("drops a cue with no duration rather than writing an invalid event", () => {
    const ass = buildAss([
      { start: 1, end: 1, text: "zero length" },
      { start: 2, end: 3, text: "real" },
    ]);
    expect(ass).not.toContain("zero length");
    expect(ass).toContain("real");
  });

  it("drops an empty cue", () => {
    expect(buildAss([{ start: 0, end: 1, text: "   " }])).not.toContain("Dialogue:");
  });
});

describe("groupWordsIntoCues", () => {
  it("groups words into phrase-length cues", () => {
    const cues = groupWordsIntoCues([
      { text: "took", start: 0, end: 0.3 },
      { text: "three", start: 0.3, end: 0.6 },
      { text: "days", start: 0.6, end: 0.9 },
    ]);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe("took three days");
    expect(cues[0]!.end).toBe(0.9);
  });

  it("breaks on a real pause, since that is how the line was spoken", () => {
    const cues = groupWordsIntoCues([
      { text: "one", start: 0, end: 0.3 },
      { text: "two", start: 1.5, end: 1.8 },
    ]);
    expect(cues).toHaveLength(2);
  });

  it("breaks a long run that never pauses", () => {
    const words = Array.from({ length: 20 }, (_, i) => ({ text: "word", start: i * 0.2, end: i * 0.2 + 0.15 }));
    expect(groupWordsIntoCues(words).length).toBeGreaterThan(1);
  });

  it("ignores the spacing entries the API interleaves", () => {
    const cues = groupWordsIntoCues([
      { text: "a", start: 0, end: 0.1 },
      { text: " ", start: 0.1, end: 0.11, type: "spacing" },
      { text: "b", start: 0.11, end: 0.2 },
    ]);
    expect(cues[0]!.text).toBe("a b");
  });

  it("returns nothing when there was no speech", () => {
    expect(groupWordsIntoCues([])).toEqual([]);
  });
});

describe("burning them in", () => {
  it("applies the subtitles after the crop, so the text isn't stretched with the picture", () => {
    const args = renderArgs("in.mp4", "out.mp4", { strategy: "crop", cropX: 656, cropWidth: 608 }, probed, {
      subtitlePath: "/tmp/x/captions.ass",
    });
    const filter = args[args.indexOf("-vf") + 1]!;
    expect(filter.indexOf("subtitles=")).toBeGreaterThan(filter.indexOf("scale="));
  });

  it("applies them over the finished frame on the blurred path", () => {
    const args = renderArgs("in.mp4", "out.mp4", { strategy: "blur" }, probed, {
      subtitlePath: "/tmp/x/captions.ass",
    });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[composited]subtitles=");
    expect(graph.indexOf("subtitles=")).toBeGreaterThan(graph.indexOf("overlay="));
  });

  it("changes nothing when there are no subtitles", () => {
    const args = renderArgs("in.mp4", "out.mp4", { strategy: "blur" }, probed);
    expect(args.join(" ")).not.toContain("subtitles=");
    expect(args.join(" ")).not.toContain("[composited]");
  });

  it("escapes a colon in the path, which ffmpeg would read as a filter option", () => {
    expect(escapeFilterPath("/tmp/a:b/c.ass")).toBe("/tmp/a\\:b/c.ass");
  });
});
