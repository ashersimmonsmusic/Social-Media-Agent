import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../lib/logger.js";
import { ingestFile } from "../assets/asset.service.js";
import { prisma } from "../../db/prisma.js";
import { extractAudio, extractFrames, probe, renderVertical } from "../video/ffmpeg.js";
import { decideReframe } from "../video/reframe.service.js";
import { buildAss } from "../video/subtitles.js";
import type { TranscriptCue } from "../transcription/types.js";

/**
 * Cutting one moment out of a long video and making it publishable.
 *
 * Re-encodes from the source rather than stream-copying. Stream copy is far
 * faster but can only cut on keyframes, which is how a clip ends up starting
 * a second early on somebody's in-breath — the whole point of snapping to
 * speech boundaries is lost at the last step.
 */

/** Frames sampled from the clip itself, not the source, so the crop suits it. */
const FRAMES_PER_CLIP = 5;

/** Safe on every filesystem and readable in a Drive listing. */
export function safeFilename(rank: number, title: string, durationSeconds: number): string {
  const words = title
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .split(/\s+/)
    .slice(0, 7)
    .join("_");
  const rankPart = String(rank).padStart(2, "0");
  return `${rankPart}_${words || "clip"}_${Math.round(durationSeconds)}s.mp4`;
}

/** The cues falling inside a clip, re-timed so zero is the clip's own start. */
export function cuesForClip(cues: TranscriptCue[], startSeconds: number, endSeconds: number): TranscriptCue[] {
  return cues
    .filter((cue) => cue.end > startSeconds && cue.start < endSeconds)
    .map((cue) => ({
      // Clamped as well as shifted: a cue straddling the edge would otherwise
      // start before the clip does, and ffmpeg ignores the whole line.
      start: Math.max(0, cue.start - startSeconds),
      end: Math.min(endSeconds - startSeconds, cue.end - startSeconds),
      text: cue.text,
    }))
    .filter((cue) => cue.end > cue.start);
}

export interface CutClipInput {
  sourcePath: string;
  workDir: string;
  clipId: string;
  rank: number;
  title: string;
  startSeconds: number;
  endSeconds: number;
  cues: TranscriptCue[];
  subtitles?: boolean;
}

/**
 * Cuts one clip, reframes it vertically, optionally burns in its subtitles, and
 * files it in the library. Returns the asset id, which is what links a Clip row
 * to something watchable.
 */
export async function cutClip(input: CutClipInput): Promise<{ assetId: string; filename: string; sizeBytes: number }> {
  const duration = input.endSeconds - input.startSeconds;
  const clipPath = join(input.workDir, `clip-${input.clipId}.mp4`);
  const outputPath = join(input.workDir, `vertical-${input.clipId}.mp4`);

  // Cut first, then reframe the cut rather than the whole source: the crop
  // decision should suit this moment, not the average of the hour around it.
  const probed = await probe(input.sourcePath);
  await renderVertical(input.sourcePath, clipPath, { strategy: "passthrough" }, probed, {
    startSeconds: input.startSeconds,
    durationSeconds: duration,
  });

  const clipProbe = await probe(clipPath);
  const decision = await decideReframe(clipProbe, "auto", () =>
    extractFrames(clipPath, clipProbe.durationSeconds, FRAMES_PER_CLIP),
  );

  let subtitlePath: string | undefined;
  if (input.subtitles) {
    const cues = cuesForClip(input.cues, input.startSeconds, input.endSeconds);
    if (cues.length > 0) {
      subtitlePath = join(input.workDir, `subs-${input.clipId}.ass`);
      await writeFile(subtitlePath, buildAss(cues), "utf8");
    }
  }

  await renderVertical(clipPath, outputPath, decision.plan, clipProbe, { subtitlePath });

  const filename = safeFilename(input.rank, input.title, duration);
  const data = await readFile(outputPath);
  const asset = await ingestFile({
    filename,
    mimeType: "video/mp4",
    data,
    source: "Clipped from a long video",
    description: `${input.title} — ${Math.round(duration)}s clip. ${decision.reason}`,
  });

  await prisma.clip.update({ where: { id: input.clipId }, data: { assetId: asset.id } });
  logger.info("clipping.clip_cut", { clipId: input.clipId, filename, sizeBytes: data.byteLength });

  return { assetId: asset.id, filename, sizeBytes: data.byteLength };
}

/** Pulls the audio for transcription. Separate so a job can retry just this. */
export async function extractJobAudio(sourcePath: string, workDir: string): Promise<Buffer> {
  const audioPath = join(workDir, "source-audio.mp3");
  await extractAudio(sourcePath, audioPath);
  return readFile(audioPath);
}
