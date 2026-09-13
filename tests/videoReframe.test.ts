import { describe, expect, it, vi } from "vitest";

// The reframe service reaches the model to look at frames; the decision logic
// under test here runs on readings that are supplied directly, so neither the
// model nor the environment is needed.
vi.mock("../src/config/env.js", () => ({ env: {} }));
vi.mock("../src/ai/AIService.js", () => ({ aiService: { generate: async () => ({ text: "{}" }) } }));

const { evenise, verticalSliceWidth, cropOffsetFor, renderArgs, REELS_MAX_SECONDS } = await import(
  "../src/modules/video/ffmpeg.js"
);
const { parseFrameReadings, planFromReadings, isAlreadyVertical } = await import(
  "../src/modules/video/reframe.service.js"
);

const landscape = { width: 1920, height: 1080, durationSeconds: 30, videoCodec: "h264", hasAudio: true };

describe("geometry", () => {
  it("forces even dimensions, because encoders reject odd ones", () => {
    expect(evenise(607.5)).toBe(608);
    expect(evenise(1)).toBe(2);
    expect(evenise(0)).toBe(2);
  });

  it("takes a 9:16 slice out of a 1080-tall frame", () => {
    expect(verticalSliceWidth(1080)).toBe(608);
    expect(verticalSliceWidth(2160)).toBe(1216);
  });

  it("centres the slice on the subject", () => {
    // Subject dead centre of a 1920-wide frame: (960 - 304) = 656.
    expect(cropOffsetFor(1920, 608, 50)).toBe(656);
  });

  it("keeps the slice inside the frame when the subject is at an edge", () => {
    expect(cropOffsetFor(1920, 608, 0)).toBe(0);
    // Clamped to the right edge rather than running past it.
    expect(cropOffsetFor(1920, 608, 100)).toBe(1920 - 608);
    expect(cropOffsetFor(1920, 608, 150)).toBe(1920 - 608);
  });
});

describe("parseFrameReadings", () => {
  it("reads a clean response", () => {
    const readings = parseFrameReadings('{"frames":[{"subject":"man at keys","centre":48,"clear":true}]}');
    expect(readings).toEqual([{ subject: "man at keys", centre: 48, clear: true }]);
  });

  it("survives a fenced or chatty response", () => {
    const readings = parseFrameReadings('Sure!\n```json\n{"frames":[{"subject":"x","centre":10,"clear":false}]}\n```');
    expect(readings).toHaveLength(1);
    expect(readings[0]!.clear).toBe(false);
  });

  it("clamps a centre outside 0-100 rather than trusting it", () => {
    expect(parseFrameReadings('{"frames":[{"subject":"x","centre":480,"clear":true}]}')[0]!.centre).toBe(100);
    expect(parseFrameReadings('{"frames":[{"subject":"x","centre":-9,"clear":true}]}')[0]!.centre).toBe(0);
  });

  it("returns nothing for junk instead of throwing", () => {
    expect(parseFrameReadings("no json here")).toEqual([]);
    expect(parseFrameReadings('{"frames":"not an array"}')).toEqual([]);
    expect(parseFrameReadings('{"frames":[{"subject":"x","clear":true}]}')).toEqual([]);
  });
});

describe("planFromReadings", () => {
  const stable = [
    { subject: "man at keys", centre: 46, clear: true },
    { subject: "man at keys", centre: 50, clear: true },
    { subject: "man at keys", centre: 52, clear: true },
  ];

  it("crops when the subject barely moves", () => {
    const decision = planFromReadings(stable, landscape);
    expect(decision.plan.strategy).toBe("crop");
    if (decision.plan.strategy !== "crop") throw new Error("expected a crop");
    expect(decision.plan.cropWidth).toBe(608);
    // Median of 46/50/52 is 50, so the slice sits centrally.
    expect(decision.plan.cropX).toBe(656);
  });

  it("falls back to the blurred fill when the subject drifts too far", () => {
    const drifting = [
      { subject: "man walking", centre: 20, clear: true },
      { subject: "man walking", centre: 55, clear: true },
      { subject: "man walking", centre: 80, clear: true },
    ];
    const decision = planFromReadings(drifting, landscape);
    expect(decision.plan.strategy).toBe("blur");
    expect(decision.reason).toMatch(/moves/);
  });

  it("falls back to the blurred fill when there is no clear subject", () => {
    const vague = [
      { subject: "wide shot of a crowd", centre: 50, clear: false },
      { subject: "stage lights", centre: 40, clear: false },
      { subject: "man at keys", centre: 45, clear: true },
    ];
    expect(planFromReadings(vague, landscape).plan.strategy).toBe("blur");
  });

  it("refuses to crop off one readable frame", () => {
    const single = [{ subject: "man at keys", centre: 50, clear: true }];
    expect(planFromReadings(single, landscape).plan.strategy).toBe("blur");
  });

  it("offsets the crop towards a subject that sits off centre", () => {
    const left = [
      { subject: "man at keys", centre: 25, clear: true },
      { subject: "man at keys", centre: 28, clear: true },
    ];
    const decision = planFromReadings(left, landscape);
    if (decision.plan.strategy !== "crop") throw new Error("expected a crop");
    expect(decision.plan.cropX).toBeLessThan(656);
    expect(decision.reason).toMatch(/left of centre/);
  });
});

describe("isAlreadyVertical", () => {
  it("recognises 9:16 footage", () => {
    expect(isAlreadyVertical({ ...landscape, width: 1080, height: 1920 })).toBe(true);
  });

  it("treats landscape and square as needing work", () => {
    expect(isAlreadyVertical(landscape)).toBe(false);
    expect(isAlreadyVertical({ ...landscape, width: 1080, height: 1080 })).toBe(false);
  });
});

describe("renderArgs", () => {
  it("crops with an explicit window and scales to 1080x1920", () => {
    const args = renderArgs("in.mp4", "out.mp4", { strategy: "crop", cropX: 656, cropWidth: 608 }, landscape);
    expect(args.join(" ")).toContain("crop=608:ih:656:0,scale=1080:1920");
    expect(args).toContain("out.mp4");
  });

  it("builds the blurred-background filter graph, keeping the whole frame", () => {
    const args = renderArgs("in.mp4", "out.mp4", { strategy: "blur" }, landscape);
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("gblur");
    expect(graph).toContain("overlay=(W-w)/2:(H-h)/2");
    expect(args).toContain("[v]");
  });

  it("always encodes what Instagram accepts", () => {
    const args = renderArgs("in.mp4", "out.mp4", { strategy: "passthrough" }, landscape);
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args).toContain("yuv420p");
    expect(args).toContain("+faststart");
  });

  it("caps the output at Instagram's Reel limit", () => {
    const long = { ...landscape, durationSeconds: 600 };
    const args = renderArgs("in.mp4", "out.mp4", { strategy: "blur" }, long);
    expect(args[args.indexOf("-t") + 1]).toBe(REELS_MAX_SECONDS.toFixed(3));
  });

  it("seeks before the input so a start point is cheap", () => {
    const args = renderArgs("in.mp4", "out.mp4", { strategy: "blur" }, landscape, { startSeconds: 12 });
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-ss") + 1]).toBe("12.000");
  });

  it("adds a silent track when the source has no audio at all", () => {
    const silent = { ...landscape, hasAudio: false };
    const args = renderArgs("in.mp4", "out.mp4", { strategy: "blur" }, silent);
    expect(args.join(" ")).toContain("anullsrc");
    expect(args).toContain("1:a:0");
  });

  it("uses the source's own audio when it has some", () => {
    const args = renderArgs("in.mp4", "out.mp4", { strategy: "blur" }, landscape);
    expect(args.join(" ")).not.toContain("anullsrc");
    expect(args).toContain("0:a:0?");
  });

  it("passes filenames as separate arguments, never interpolated into a command", () => {
    const nasty = "my clip; rm -rf /.mp4";
    const args = renderArgs(nasty, "out.mp4", { strategy: "blur" }, landscape);
    expect(args).toContain(nasty);
  });
});
