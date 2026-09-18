import { beforeEach, describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = { INSTAGRAM_AUDIO_NAME: undefined, MUSIC_MAX_TRACK_MB: 80 };

vi.mock("../src/config/env.js", () => ({ env: envState }));
vi.mock("../src/lib/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../src/db/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/modules/drive/drive.service.js", () => ({
  getTrack: async () => ({ name: "x.mp3" }),
  downloadToFile: async () => ({ name: "x.mp3", sizeBytes: 1 }),
  DriveError: class DriveError extends Error {},
}));

const { audioGraph, renderArgs } = await import("../src/modules/video/ffmpeg.js");
const { parseStoredBed, clampGain, trackTitle, audioNameFor, formatBed, DEFAULT_GAIN_DB } = await import(
  "../src/modules/music/music.service.js"
);

const landscape = { width: 1920, height: 1080, durationSeconds: 30, videoCodec: "h264", hasAudio: true };
const silent = { ...landscape, hasAudio: false };
const crop = { strategy: "crop", cropX: 656, cropWidth: 608 } as const;
const bed = { path: "/tmp/bed.mp3", gainDb: -14, duck: true };

describe("audioGraph", () => {
  it("ducks the bed under the voice and mixes both without halving either", () => {
    const graph = audioGraph(bed, true, 30);
    // The bed is the thing compressed; the voice only triggers it.
    expect(graph).toContain("[bed][key]sidechaincompress=");
    expect(graph).toContain("asplit=2[voice][key]");
    expect(graph).toContain("normalize=0");
    expect(graph).toMatch(/\[a\]$/);
  });

  it("leaves the voice alone when ducking is off", () => {
    const graph = audioGraph({ ...bed, duck: false }, true, 30);
    expect(graph).not.toContain("sidechaincompress");
    expect(graph).toContain("amix=inputs=2");
  });

  it("makes the bed the whole soundtrack when the footage is silent", () => {
    const graph = audioGraph(bed, false, 30);
    expect(graph.startsWith("[1:a]")).toBe(true);
    expect(graph.endsWith("[a]")).toBe(true);
    expect(graph).not.toContain("amix");
    expect(graph).not.toContain("[0:a]");
  });

  it("fades out before the clip ends rather than stopping dead", () => {
    // 30s clip, 1.5s tail: the fade has to start at 28.5s, not at 30.
    expect(audioGraph(bed, true, 30)).toContain("afade=t=out:st=28.500");
  });

  it("does not ask for a negative fade start on a clip shorter than the tail", () => {
    expect(audioGraph(bed, true, 1)).toContain("afade=t=out:st=0.000");
  });

  it("trims and rebases the track when the bed starts partway in", () => {
    const graph = audioGraph({ ...bed, startSeconds: 32 }, true, 30);
    expect(graph).toContain("atrim=start=32.000,asetpts=N/SR/TB");
    // The fade in still measures from the clip's start, not the track's.
    expect(graph).toContain("afade=t=in:st=0");
  });
});

describe("renderArgs with a music bed", () => {
  it("loops the track so a short bed covers a long clip", () => {
    const args = renderArgs("in.mp4", "out.mp4", crop, landscape, { music: bed });
    expect(args.join(" ")).toContain("-stream_loop -1 -i /tmp/bed.mp3");
  });

  it("moves a simple crop into the complex graph, because -vf cannot coexist with it", () => {
    const args = renderArgs("in.mp4", "out.mp4", crop, landscape, { music: bed });
    expect(args).not.toContain("-vf");
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[0:v]crop=608:ih:656:0");
    expect(graph).toContain("[v];");
    expect(args).toContain("[v]");
    expect(args).toContain("[a]");
  });

  it("keeps the blurred-fill graph intact and appends the audio to it", () => {
    const args = renderArgs("in.mp4", "out.mp4", { strategy: "blur" }, landscape, { music: bed });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("split=2[bg][fg]");
    expect(graph).toContain("sidechaincompress");
  });

  it("does not also synthesise silence when the footage has none — the bed is the audio", () => {
    const args = renderArgs("in.mp4", "out.mp4", crop, silent, { music: bed });
    expect(args.join(" ")).not.toContain("anullsrc");
    // Input 1 has to stay the bed, or the graph's [1:a] would name the wrong stream.
    expect(args.indexOf("/tmp/bed.mp3")).toBe(args.indexOf("-i", args.indexOf("-i") + 1) + 1);
  });

  it("burns subtitles over the picture as well as mixing the bed", () => {
    const args = renderArgs("in.mp4", "out.mp4", crop, landscape, { music: bed, subtitlePath: "/tmp/s.ass" });
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("subtitles='/tmp/s.ass'");
    expect(graph).toContain("sidechaincompress");
  });

  it("leaves the no-music command exactly as it was", () => {
    const args = renderArgs("in.mp4", "out.mp4", crop, landscape);
    expect(args).toContain("-vf");
    expect(args).toContain("0:a:0?");
    expect(args.join(" ")).not.toContain("stream_loop");
  });

  it("still synthesises silence for a silent clip with no bed", () => {
    expect(renderArgs("in.mp4", "out.mp4", crop, silent).join(" ")).toContain("anullsrc");
  });
});

describe("the stored bed", () => {
  it("reads a complete setting", () => {
    expect(parseStoredBed({ driveFileId: "abc", name: "Nightdrive.mp3", gainDb: -9, startSeconds: 12, enabled: true }))
      .toEqual({ driveFileId: "abc", name: "Nightdrive.mp3", gainDb: -9, startSeconds: 12, enabled: true });
  });

  it("fills in defaults rather than handing undefined to ffmpeg", () => {
    const parsed = parseStoredBed({ driveFileId: "abc" });
    expect(parsed).toEqual({
      driveFileId: "abc",
      name: "a track",
      gainDb: DEFAULT_GAIN_DB,
      startSeconds: 0,
      enabled: true,
    });
  });

  it("treats a row with no track as no setting at all", () => {
    expect(parseStoredBed({ gainDb: -9 })).toBeNull();
    expect(parseStoredBed({ driveFileId: "" })).toBeNull();
    expect(parseStoredBed(null)).toBeNull();
    expect(parseStoredBed("a string")).toBeNull();
  });

  it("clamps a level that would be inaudible or would drown the clip", () => {
    expect(clampGain(-400)).toBe(-40);
    expect(clampGain(12)).toBe(0);
    expect(clampGain(-9.27)).toBe(-9.3);
  });
});

describe("naming the audio", () => {
  beforeEach(() => {
    envState.INSTAGRAM_AUDIO_NAME = undefined;
  });

  it("reads a filename as a title", () => {
    expect(trackTitle("night_drive-final.mp3")).toBe("night drive final");
  });

  it("uses the track alone when no artist name is configured", () => {
    expect(audioNameFor("Nightdrive.mp3")).toBe("Nightdrive");
  });

  it("credits the artist alongside the track", () => {
    envState.INSTAGRAM_AUDIO_NAME = "Asher Simmons";
    expect(audioNameFor("Nightdrive.mp3")).toBe("Nightdrive · Asher Simmons");
  });

  it("still names the audio when there was no bed, so the Reel is attributable", () => {
    envState.INSTAGRAM_AUDIO_NAME = "Asher Simmons";
    expect(audioNameFor(undefined)).toBe("Asher Simmons");
  });

  it("says nothing when there is nothing to say", () => {
    expect(audioNameFor(undefined)).toBeUndefined();
  });

  it("keeps the name short enough that it cannot be what fails a publish", () => {
    envState.INSTAGRAM_AUDIO_NAME = "A".repeat(200);
    expect(audioNameFor("B".repeat(200))!.length).toBeLessThanOrEqual(80);
  });
});

describe("formatBed", () => {
  it("explains how to set one when there is none", () => {
    expect(formatBed(null)).toMatch(/\/music/);
  });

  it("says plainly when a track is chosen but switched off", () => {
    const text = formatBed({ driveFileId: "a", name: "Nightdrive.mp3", gainDb: -14, startSeconds: 0, enabled: false });
    expect(text).toContain("Nightdrive");
    expect(text).toMatch(/Currently: off/);
  });
});
