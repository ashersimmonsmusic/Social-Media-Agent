import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";

const run = promisify(execFile);

/** Instagram's API refuses Reels longer than this, so nothing longer is rendered. */
export const REELS_MAX_SECONDS = 90;

export const TARGET_WIDTH = 1080;
export const TARGET_HEIGHT = 1920;

/**
 * The timeout exists because an ffmpeg that hangs would hold the process open
 * forever, not to cap how long a real render may take — so it scales with the
 * source. A 2GB 4K file spends minutes just decoding to the point it needs, and
 * a fixed ceiling would kill the large renders this limit was raised to allow.
 */
const RENDER_TIMEOUT_BASE_MS = 6 * 60 * 1000;
const RENDER_TIMEOUT_PER_GB_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30 * 1000;

export function renderTimeoutFor(sourceBytes: number): number {
  const gb = Math.max(0, sourceBytes) / 1024 ** 3;
  return Math.round(RENDER_TIMEOUT_BASE_MS + gb * RENDER_TIMEOUT_PER_GB_MS);
}

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

/**
 * A music track to sit under a clip.
 *
 * Instagram's own catalogue cannot be reached from the publishing API at all, so
 * the only way a post has music is if the music is already in the file. That
 * makes this the real feature rather than a convenience: the bed is mixed in
 * before the clip is ever uploaded.
 */
export interface MusicBed {
  /** An audio file on disk. Looped if it is shorter than the clip. */
  path: string;
  /**
   * How loud the bed sits, in decibels relative to the file's own level.
   * Negative is quieter, which is nearly always what a bed wants.
   */
  gainDb: number;
  /** Where in the track to start, so a bed can open on the good bar rather than the intro. */
  startSeconds?: number;
  /**
   * Push the bed down while the source audio is loud. Pointless when the source
   * is silent — there is nothing to duck under — and wrong when the source is
   * ambience rather than a voice, so it is a decision rather than a default.
   */
  duck?: boolean;
}

export interface RenderOptions {
  startSeconds?: number;
  durationSeconds?: number;
  /** Used only to scale the hang timeout — a bigger source legitimately takes longer. */
  sourceBytes?: number;
  /** An .ass file to burn into the picture. Applied last, over the finished frame. */
  subtitlePath?: string;
  /** Music to mix in under the clip's own audio. */
  music?: MusicBed;
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
/**
 * Pulls the audio out as a small mono MP3 for transcription.
 *
 * Mono at 16kHz is what speech recognition wants and keeps a 90-second clip
 * around a megabyte — the audio is sent to a third party, so sending less of it
 * is also the point.
 *
 * Takes the same start and duration as the render, or the subtitles would be
 * timed against a different piece of the clip than the one on screen.
 */
export async function extractAudio(
  input: string,
  output: string,
  options: { startSeconds?: number; durationSeconds?: number } = {},
): Promise<void> {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (options.startSeconds) args.push("-ss", options.startSeconds.toFixed(3));
  args.push("-i", input);
  if (options.durationSeconds) args.push("-t", options.durationSeconds.toFixed(3));
  args.push("-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", output);

  await ffmpeg(args, PROBE_TIMEOUT_MS * 8, "pull the audio out of that video");
}

/**
 * Escapes a path for ffmpeg's subtitles filter, where a colon separates filter
 * options — so a path containing one would be read as something other than a
 * filename.
 */
export function escapeFilterPath(path: string): string {
  return path.replace(/:/g, "\\:").replace(/'/g, "\\'");
}

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

/**
 * How the video reaches the output.
 *
 * `chain` is a plain list of filters that can go straight into `-vf`; `graph`
 * has named pads and needs `-filter_complex`. The distinction matters because a
 * music bed forces the whole thing into a complex graph — an audio graph and a
 * `-vf` cannot both feed the same output — and only then does a chain need
 * wrapping.
 */
type VideoFilter = { kind: "chain"; chain: string } | { kind: "graph"; graph: string };

function videoFilter(plan: ReframePlan, subtitlePath?: string): VideoFilter {
  // Burned in last, over the finished vertical frame — applying it before the
  // crop or scale would stretch the text along with the picture.
  const subs = subtitlePath ? `,subtitles='${escapeFilterPath(subtitlePath)}'` : "";

  switch (plan.strategy) {
    case "crop":
      return {
        kind: "chain",
        chain: `crop=${plan.cropWidth}:ih:${plan.cropX}:0,scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:flags=lanczos${subs}`,
      };
    case "blur":
      // The background is the same footage enlarged to fill the frame and
      // blurred; the real picture sits on top at full width. Nothing is cut.
      return {
        kind: "graph",
        graph:
          `[0:v]split=2[bg][fg];` +
          `[bg]scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=increase,` +
          `crop=${TARGET_WIDTH}:${TARGET_HEIGHT},gblur=sigma=24[blurred];` +
          `[fg]scale=${TARGET_WIDTH}:-2[front];` +
          `[blurred][front]overlay=(W-w)/2:(H-h)/2${subtitlePath ? "[composited]" : "[v]"}` +
          (subtitlePath ? `;[composited]subtitles='${escapeFilterPath(subtitlePath)}'[v]` : ""),
      };
    case "passthrough":
      return {
        kind: "chain",
        chain:
          `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,` +
          `pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black${subs}`,
      };
  }
}

/** Long enough not to sound like a cut, short enough not to waste the opening bar. */
const BED_FADE_IN_SECONDS = 0.75;
/** Longer than the fade in: a bed that stops dead reads as a mistake. */
const BED_FADE_OUT_SECONDS = 1.5;

/**
 * How hard the bed gets pushed down while there is speech.
 *
 * The threshold is measured on the voice, not the music, and is a linear
 * amplitude rather than decibels — 0.03 is roughly -30dBFS, which is quiet
 * enough to catch a normal speaking level without room tone triggering it.
 * Measured against a full-scale tone these settings pull the bed down about
 * 10dB while the voice is present; raising the ratio further adds barely a
 * decibel, and raising the threshold to 0.1 loses almost all of it.
 */
const DUCK_THRESHOLD = 0.03;
const DUCK_RATIO = 6;
const DUCK_ATTACK_MS = 15;
/** Slow enough that the bed doesn't pump back up between words. */
const DUCK_RELEASE_MS = 600;

/** Both streams have to agree on format before they can be mixed. */
const MIX_FORMAT = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo";

/**
 * The audio half of the filter graph, producing `[a]`.
 *
 * Exported so a test can read the graph without running an encode: the ducking
 * is the part most likely to be subtly wrong, and it is far cheaper to assert on
 * than to listen to.
 */
export function audioGraph(bed: MusicBed, hasSourceAudio: boolean, durationSeconds: number): string {
  const start = Math.max(0, bed.startSeconds ?? 0);
  // asetpts rebases the timeline to zero after the trim, so the fades below
  // measure from the start of the clip rather than the start of the track.
  const trim = start > 0 ? `atrim=start=${start.toFixed(3)},asetpts=N/SR/TB,` : "";
  const fadeOutAt = Math.max(0, durationSeconds - BED_FADE_OUT_SECONDS);

  const shaped =
    `${trim}volume=${bed.gainDb.toFixed(1)}dB,` +
    `afade=t=in:st=0:d=${BED_FADE_IN_SECONDS},` +
    `afade=t=out:st=${fadeOutAt.toFixed(3)}:d=${BED_FADE_OUT_SECONDS},` +
    MIX_FORMAT;

  // Nothing to mix against: the bed is the whole soundtrack.
  if (!hasSourceAudio) return `[1:a]${shaped}[a]`;

  // normalize=0 because amix otherwise divides every input by the number of
  // inputs, which would quietly halve the voice the moment a bed was added.
  const mix = `amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`;

  if (!bed.duck) return `[1:a]${shaped}[bed];[0:a]${MIX_FORMAT}[voice];[voice][bed]${mix}`;

  // The voice is needed twice: once as itself in the mix, once as the key that
  // pushes the bed down while it is talking. sidechaincompress takes the bed as
  // its main input and the voice as the trigger, which is the reverse of how it
  // reads — the thing being compressed comes first.
  return (
    `[0:a]${MIX_FORMAT},asplit=2[voice][key];` +
    `[1:a]${shaped}[bed];` +
    `[bed][key]sidechaincompress=threshold=${DUCK_THRESHOLD}:ratio=${DUCK_RATIO}:` +
    `attack=${DUCK_ATTACK_MS}:release=${DUCK_RELEASE_MS}[ducked];` +
    `[voice][ducked]${mix}`
  );
}

/**
 * Builds the full ffmpeg argument list. Exported so tests can assert on the
 * command without running an encode.
 */
export function renderArgs(input: string, output: string, plan: ReframePlan, probed: VideoProbe, options: RenderOptions = {}): string[] {
  const start = Math.max(0, options.startSeconds ?? 0);
  const requested = options.durationSeconds ?? probed.durationSeconds - start;
  const duration = Math.min(REELS_MAX_SECONDS, Math.max(1, requested));

  const video = videoFilter(plan, options.subtitlePath);
  const bed = options.music;
  const args = ["-hide_banner", "-loglevel", "error", "-y"];

  // -ss before -i seeks by keyframe, which is fast and accurate enough here.
  if (start > 0) args.push("-ss", start.toFixed(3));
  args.push("-i", input);

  if (bed) {
    // A track shorter than the clip is looped rather than left to run out
    // halfway through. -t below is what stops it, so the loop cannot run away.
    args.push("-stream_loop", "-1", "-i", bed.path);
  } else if (!probed.hasAudio) {
    // Instagram has been known to reject a Reel with no audio track at all, so a
    // silent one is synthesised rather than leaving the stream absent.
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  }

  if (bed) {
    // With an audio graph in play the video has to go through the same
    // -filter_complex: ffmpeg will not accept a -vf alongside it for the same
    // output. A chain is wrapped rather than rewritten, so the picture is
    // identical either way.
    const graph = video.kind === "chain" ? `[0:v]${video.chain}[v]` : video.graph;
    args.push("-filter_complex", `${graph};${audioGraph(bed, probed.hasAudio, duration)}`, "-map", "[v]", "-map", "[a]");
  } else if (video.kind === "chain") {
    args.push("-vf", video.chain, "-map", "0:v:0", "-map", probed.hasAudio ? "0:a:0?" : "1:a:0");
  } else {
    args.push("-filter_complex", video.graph, "-map", "[v]", "-map", probed.hasAudio ? "0:a:0?" : "1:a:0");
  }

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
  await ffmpeg(
    renderArgs(input, output, plan, probed, options),
    renderTimeoutFor(options.sourceBytes ?? 0),
    "convert that video to vertical",
  );
}

/**
 * Where to put a source file and its render while ffmpeg works.
 *
 * A container's own temp space is small and shared with everything else the
 * process does, which is what made a 300MB cap feel necessary. A mounted volume
 * is sized deliberately, so it is preferred when there is one.
 */
export function workRoot(): string {
  return env.VIDEO_WORK_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || tmpdir();
}

const MB = 1024 ** 2;

/**
 * Space to allow for the render itself.
 *
 * A flat multiple of the source was wrong: the output is capped at 90 seconds
 * of 1080x1920, so it is roughly this size whether the source is 100MB or 4GB.
 * Scaling with the input demanded gigabytes to make a thirty-second clip.
 */
const OUTPUT_ALLOWANCE_BYTES = 150 * MB;
/** Frames, container overhead, and not running the disk to literal zero. */
const SAFETY_BYTES = 150 * MB;

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
}

export class NotEnoughDiskError extends Error {
  constructor(neededBytes: number, freeBytes: number, dir: string) {
    super(
      `Not enough working space: this needs about ${gb(neededBytes)} and there's ${gb(freeBytes)} free on ${dir}.\n\n` +
        `Either add disk (Railway → your service → Settings → Volumes) or export a smaller version. ` +
        `If ${dir} looks like a temporary folder rather than a volume, the volume isn't mounted where I'm working — ` +
        `set VIDEO_WORK_DIR to its mount path.`,
    );
    this.name = "NotEnoughDiskError";
  }
}

export interface DiskReport {
  dir: string;
  freeBytes: number;
  totalBytes: number;
  /** False when the filesystem wouldn't answer, so a caller doesn't report zeros as fact. */
  known: boolean;
}

export async function diskReport(dir = workRoot()): Promise<DiskReport> {
  try {
    const stats = await statfs(dir);
    return { dir, freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize, known: true };
  } catch (error) {
    logger.warn("video.disk_check_failed", { dir, error: String(error) });
    return { dir, freeBytes: 0, totalBytes: 0, known: false };
  }
}

/**
 * What a job of this size needs on disk, start to finish.
 *
 * `extraBytes` covers anything else the job will fetch alongside the source — a
 * music track, today. Reserved up front rather than discovered halfway through,
 * because the failure mode of running out mid-render is a full disk for
 * everything else in the container, not just a failed clip.
 */
export function spaceNeededFor(sourceBytes: number, extraBytes = 0): number {
  return sourceBytes + Math.max(0, extraBytes) + OUTPUT_ALLOWANCE_BYTES + SAFETY_BYTES;
}

/**
 * Refuses a job that cannot fit before downloading it to find out.
 *
 * Running the disk to zero fails every other write in the container, not just
 * this one, so the clean refusal is worth the check.
 */
export async function assertRoomFor(sourceBytes: number, dir = workRoot(), extraBytes = 0): Promise<void> {
  const needed = spaceNeededFor(sourceBytes, extraBytes);
  const report = await diskReport(dir);
  // A filesystem that won't report its size is not a reason to refuse work.
  if (report.known && report.freeBytes < needed) {
    throw new NotEnoughDiskError(needed, report.freeBytes, dir);
  }
}

/**
 * Working files live in their own subdirectory rather than loose among the
 * stored library, which shares the same volume.
 */
const TEMP_SUBDIR = ".video-tmp";

/** Old enough that nothing still running could own it. */
const STALE_TEMP_MS = 6 * 60 * 60 * 1000;

/**
 * Removes working directories left behind by a render that died.
 *
 * A container killed mid-render — a deploy, a restart, an out-of-memory — leaves
 * its source file on the volume with nothing to clean it up. On a small volume
 * two of those is the whole disk, and the symptom is every later render
 * refusing for lack of space that nothing appears to be using.
 */
export async function sweepStaleWorkDirs(): Promise<number> {
  const root = join(workRoot(), TEMP_SUBDIR);
  let removed = 0;

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0; // nothing has run yet
  }

  for (const entry of entries) {
    if (!entry.startsWith("video-")) continue;
    const path = join(root, entry);
    try {
      const info = await stat(path);
      if (Date.now() - info.mtimeMs < STALE_TEMP_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      logger.warn("video.sweep_failed", { path, error: String(error) });
    }
  }

  if (removed > 0) logger.info("video.stale_work_dirs_removed", { removed });
  return removed;
}

/** Runs `work` with a private temp directory that is always removed after. */
export async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const root = join(workRoot(), TEMP_SUBDIR);
  // The volume's mount point exists, but this subdirectory may not.
  await mkdir(root, { recursive: true }).catch(() => {});
  const dir = await mkdtemp(join(root, "video-"));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
