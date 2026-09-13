import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Instagram's API refuses Reels longer than this, so nothing longer is rendered. */
export const REELS_MAX_SECONDS = 90;

export const TARGET_WIDTH = 1080;
export const TARGET_HEIGHT = 1920;

/**
 * Rendering a 90-second clip takes tens of seconds on a small container. The
 * timeout exists because an ffmpeg that hangs would otherwise hold the process
 * open forever; it is generous enough that a legitimate render never trips it.
 */
const RENDER_TIMEOUT_MS = 6 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30 * 1000;

/** Frames are only for the model to look at, so they're small and few. */
const FRAME_WIDTH = 512;
const MAX_FRAMES = 10;

export class VideoToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoToolError";
  }
}

export interface VideoProbe {
  width: number;
  height: number;
  durationSeconds: number;
  videoCodec: string;
  hasAudio: boolean;
}

/**
 * How a landscape clip becomes a vertical one.
 *
 * `crop` takes a tall slice and loses whatever falls outside it — right when
 * the subject stays put, wrong when it moves. `blur` keeps the entire frame,
 * centred over a blurred enlargement of itself, and loses nothing at the cost
 * of a smaller picture. `passthrough` is for footage already shot vertical.
 */
export type ReframePlan =
  | { strategy: "crop"; cropX: number; cropWidth: number }
  | { strategy: "blur" }
  | { strategy: "passthrough" };

export interface RenderOptions {
  startSeconds?: number;
  durationSeconds?: number;
}

/**
 * Arguments are always passed as an array, never a command string — a filename
 * from Drive is untrusted input, and there is no shell here for it to escape
 * into.
 */
async function ffmpeg(args: string[], timeoutMs: number, what: string): Promise<string> {
  try {
    const { stdout } = await run("ffmpeg", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    throw new VideoToolError(describeFailure(error, what));
  }
}

function describeFailure(error: unknown, what: string): string {
  const err = error as { killed?: boolean; code?: string; stderr?: string; message?: string };
  if (err?.killed || err?.code === "ETIMEDOUT") {
    return `Video processing took too long while trying to ${what}, so I stopped it.`;
  }
  if (err?.code === "ENOENT") {
    return "ffmpeg isn't installed in this environment, so I can't process video at all.";
  }
  // ffmpeg's real reason is the last line of stderr; the rest is banner noise.
  const stderr = (err?.stderr ?? "").trim().split("\n").filter(Boolean);
  const reason = stderr.length > 0 ? stderr[stderr.length - 1]! : (err?.message ?? "unknown error");
  return `Couldn't ${what}: ${reason.slice(0, 300)}`;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

export async function probe(path: string): Promise<VideoProbe> {
  let stdout: string;
  try {
    const result = await run(
      "ffprobe",
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (error) {
    throw new VideoToolError(describeFailure(error, "read that video's details"));
  }

  let parsed: { streams?: ProbeStream[]; format?: { duration?: string } };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new VideoToolError("I couldn't make sense of that file — it may not be a video.");
  }

  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video?.width || !video.height) {
    throw new VideoToolError("That file has no video in it that I can read.");
  }

  // Rotated phone footage reports its stored dimensions here; ffmpeg applies the
  // rotation on decode, so the numbers can disagree with what you see. The
  // reframe decision is made from extracted frames, which are already rotated.
  const durationSeconds = Number(parsed.format?.duration ?? video.duration ?? 0);

  return {
    width: video.width,
    height: video.height,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    videoCodec: video.codec_name ?? "unknown",
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

/**
 * Pulls evenly spaced stills so the model can see what's in the clip. Returned
 * in playback order, which is what makes "does the subject move?" answerable.
 */
export async function extractFrames(path: string, durationSeconds: number, count = 6): Promise<Buffer[]> {
  const wanted = Math.max(2, Math.min(count, MAX_FRAMES));
  const dir = await mkdtemp(join(tmpdir(), "frames-"));
  try {
    // An fps below one frame per second is expressed as a fraction; guard
    // against a zero-length probe producing a divide by zero.
    const span = durationSeconds > 0.5 ? durationSeconds : 1;
    await ffmpeg(
      [
        "-hide_banner",
        "-loglevel", "error",
        "-i", path,
        "-vf", `fps=${wanted}/${span.toFixed(3)},scale=${FRAME_WIDTH}:-2`,
        "-frames:v", String(wanted),
        "-q:v", "4",
        join(dir, "frame-%03d.jpg"),
      ],
      PROBE_TIMEOUT_MS * 4,
      "pull still frames out of that video",
    );

    const names = (await readdir(dir)).filter((name) => name.endsWith(".jpg")).sort();
    if (names.length === 0) throw new VideoToolError("I couldn't get any still frames out of that video.");
    return await Promise.all(names.map((name) => readFile(join(dir, name))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Video encoders reject odd dimensions, so every computed width is forced even.
 * Clamped to a minimum of 2 because a zero-width crop is not a crop.
 */
export function evenise(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * The same rounding for an offset rather than a size. Zero is a legitimate
 * offset — it means the left edge — so it must not be clamped up to 2, which
 * would nudge the framing of every subject sitting hard left.
 */
function evenOffset(value: number): number {
  return Math.max(0, Math.round(value / 2) * 2);
}

/** The width of a 9:16 slice out of a frame this tall. */
export function verticalSliceWidth(height: number): number {
  return evenise((height * TARGET_WIDTH) / TARGET_HEIGHT);
}

/**
 * Turns a horizontal position expressed as a percentage of the frame into a
 * crop offset, keeping the whole slice inside the frame. A subject at 90%
 * cannot be centred, so the slice stops at the edge rather than running off it.
 */
export function cropOffsetFor(width: number, cropWidth: number, centrePercent: number): number {
  const centre = (Math.max(0, Math.min(100, centrePercent)) / 100) * width;
  const raw = centre - cropWidth / 2;
  return evenOffset(Math.max(0, Math.min(width - cropWidth, raw)));
}

function filterFor(plan: ReframePlan): { args: string[]; label: string } {
  switch (plan.strategy) {
    case "crop":
      return {
        args: [
          "-vf",
          `crop=${plan.cropWidth}:ih:${plan.cropX}:0,scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:flags=lanczos`,
        ],
        label: "-vf",
      };
    case "blur":
      // The background is the same footage enlarged to fill the frame and
      // blurred; the real picture sits on top at full width. Nothing is cut.
      return {
        args: [
          "-filter_complex",
          `[0:v]split=2[bg][fg];` +
            `[bg]scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase,` +
            `crop=${TARGET_WIDTH}:${TARGET_HEIGHT},gblur=sigma=24[blurred];` +
            `[fg]scale=${TARGET_WIDTH}:-2[front];` +
            `[blurred][front]overlay=(W-w)/2:(H-h)/2[v]`,
          "-map",
          "[v]",
        ],
        label: "-filter_complex",
      };
    case "passthrough":
      return {
        args: [
          "-vf",
          `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,` +
            `pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`,
        ],
        label: "-vf",
      };
  }
}

/**
 * Builds the full ffmpeg argument list. Exported so tests can assert on the
 * command without running an encode.
 */
export function renderArgs(input: string, output: string, plan: ReframePlan, probed: VideoProbe, options: RenderOptions = {}): string[] {
  const start = Math.max(0, options.startSeconds ?? 0);
  const requested = options.durationSeconds ?? probed.durationSeconds - start;
  const duration = Math.min(REELS_MAX_SECONDS, Math.max(1, requested));

  const filter = filterFor(plan);
  const args = ["-hide_banner", "-loglevel", "error", "-y"];

  // -ss before -i seeks by keyframe, which is fast and accurate enough here.
  if (start > 0) args.push("-ss", start.toFixed(3));
  args.push("-i", input);

  // Instagram has been known to reject a Reel with no audio track at all, so a
  // silent one is synthesised rather than leaving the stream absent.
  if (!probed.hasAudio) {
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  }

  args.push(...filter.args);
  if (filter.label === "-vf") args.push("-map", "0:v:0");
  args.push("-map", probed.hasAudio ? "0:a:0?" : "1:a:0");

  args.push(
    "-t", duration.toFixed(3),
    // H.264 + AAC in yuv420p is the only combination Instagram reliably accepts;
    // anything else fails at the container stage with an unhelpful code 24.
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-g", "60",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
    "-shortest",
    "-movflags", "+faststart",
    output,
  );

  return args;
}

export async function renderVertical(
  input: string,
  output: string,
  plan: ReframePlan,
  probed: VideoProbe,
  options: RenderOptions = {},
): Promise<void> {
  await ffmpeg(renderArgs(input, output, plan, probed, options), RENDER_TIMEOUT_MS, "convert that video to vertical");
}

/** Runs `work` with a private temp directory that is always removed after. */
export async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "video-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
