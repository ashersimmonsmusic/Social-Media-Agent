import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../db/prisma.js";
import { ingestFile } from "../assets/asset.service.js";
import { recordAudit } from "../audit/audit.service.js";
import { downloadToFile, formatDuration, getVideo } from "../drive/drive.service.js";
import {
  assertRoomFor,
  extractAudio,
  extractFrames,
  probe,
  renderVertical,
  withTempDir,
  REELS_MAX_SECONDS,
  VideoToolError,
  type ReframePlan,
} from "./ffmpeg.js";
import { decideReframe, type ReframeMode } from "./reframe.service.js";
import { activeBed, audioNameFor, prepareBed, trackTitle } from "../music/music.service.js";
import { describeClipFromFrames } from "../content/caption.service.js";
import { buildAss } from "./subtitles.js";
import { transcriber } from "../transcription/index.js";
import { TranscriptionNotConfiguredError } from "../transcription/types.js";

/** Enough stills to tell whether a subject moves, and what is in shot. */
const FRAMES_TO_SAMPLE = 6;

export interface PrepareVideoInput {
  driveFileId: string;
  /** Burn what's spoken onto the picture. Costs a fraction of a penny per clip. */
  subtitles?: boolean;
  /** "auto" lets the model decide; the others override it. */
  mode?: ReframeMode;
  /** Where in the source clip to start, for footage longer than Instagram allows. */
  startSeconds?: number;
  /**
   * Leave out to use whatever /music is set to. False skips the bed for this one
   * render without changing the setting — the escape hatch for a clip whose own
   * audio is the point.
   */
  music?: boolean;
}

export interface PreparedVideo {
  assetId: string;
  /** What the stills show, so a caption can be written without watching it. */
  whatItShows?: string;
  /** What was said, when subtitles were asked for and there was speech to find. */
  transcript?: string;
  /** Why there are no subtitles, when they were asked for and didn't happen. */
  subtitleProblem?: string;
  filename: string;
  sourceName: string;
  sourceShape: string;
  outputSeconds: number;
  sizeBytes: number;
  strategy: ReframePlan["strategy"];
  reason: string;
  observations: string[];
  /** Set when the source was longer than Instagram allows and had to be cut. */
  trimmedFromSeconds?: number;
  startSeconds: number;
  /** The track mixed underneath, when there was one. */
  musicTrack?: string;
  /** What Instagram will call this Reel's audio, when it publishes. */
  audioName?: string;
}

function slugForOutput(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  const safe = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${safe || "clip"}-vertical.mp4`;
}

/**
 * Turns one Drive video into a vertical clip in the content library, ready to be
 * proposed as a post.
 *
 * Nothing here publishes anything. The result is an Asset and a description of
 * what was done to it, so the decision Asher is asked to approve is the actual
 * finished clip rather than a promise about one.
 */
export async function prepareVideoForReels(input: PrepareVideoInput): Promise<PreparedVideo> {
  const maxBytes = env.VIDEO_MAX_SOURCE_MB * 1024 * 1024;
  const startSeconds = Math.max(0, input.startSeconds ?? 0);

  return withTempDir(async (dir) => {
    const sourcePath = join(dir, "source");
    const outputPath = join(dir, "vertical.mp4");

    // Checked before the download, not after: discovering there is no room for
    // a 2GB file having already fetched it wastes the time and the bandwidth,
    // and leaves the disk full for everything else in the container.
    const { sizeBytes } = await getVideo(input.driveFileId);
    // The bed is fetched into the same working directory, so its worst case has
    // to be reserved now rather than discovered after the source is downloaded.
    const bedWanted = input.music !== false && (await activeBed()) !== null;
    await assertRoomFor(sizeBytes, undefined, bedWanted ? env.MUSIC_MAX_TRACK_MB * 1024 * 1024 : 0);

    const meta = await downloadToFile(input.driveFileId, sourcePath, maxBytes);
    const probed = await probe(sourcePath);

    if (startSeconds > 0 && startSeconds >= probed.durationSeconds) {
      throw new VideoToolError(
        `You asked me to start ${startSeconds}s in, but ${meta.name} is only ` +
          `${formatDuration(probed.durationSeconds * 1000)} long.`,
      );
    }

    const available = probed.durationSeconds - startSeconds;
    const trimmed = available > REELS_MAX_SECONDS;

    // Extracted once and shared: the reframe asks where the subject is, the
    // description asks what's in shot, and running ffmpeg over the clip twice
    // for the same stills would double the slowest part of this.
    let frames: Buffer[] | null = null;
    const getFrames = async () => {
      frames ??= await extractFrames(sourcePath, probed.durationSeconds, FRAMES_TO_SAMPLE);
      return frames;
    };

    const decision = await decideReframe(probed, input.mode ?? "auto", getFrames);

    // What the clip shows, so a caption can be written against something real
    // rather than the filename. Never fatal: a clip without a description is
    // still a clip, and he can say what's in it himself.
    let whatItShows: string | undefined;
    try {
      whatItShows = await describeClipFromFrames(
        await getFrames(),
        `${probed.width}x${probed.height}`,
      );
    } catch (error) {
      logger.warn("video.describe_failed", { error: String(error) });
    }

    // Subtitles before the render, because they are burned into the picture
    // rather than laid over it afterwards.
    let subtitlePath: string | undefined;
    let transcript: string | undefined;
    let subtitleProblem: string | undefined;

    if (input.subtitles) {
      try {
        const audioPath = join(dir, "audio.mp3");
        await extractAudio(sourcePath, audioPath, {
          startSeconds,
          durationSeconds: Math.min(REELS_MAX_SECONDS, probed.durationSeconds - startSeconds),
        });

        const result = await transcriber().transcribe(await readFile(audioPath), "audio.mp3");
        if (result.cues.length === 0) {
          subtitleProblem = "I couldn't hear any speech in that clip, so there's nothing to put on screen.";
        } else {
          subtitlePath = join(dir, "captions.ass");
          await writeFile(subtitlePath, buildAss(result.cues), "utf8");
          transcript = result.text;
        }
      } catch (error) {
        // Never fatal. A clip without subtitles is still the clip he asked for,
        // and losing the render over a transcription failure would be worse
        // than delivering it plain and saying why.
        subtitleProblem =
          error instanceof TranscriptionNotConfiguredError
            ? error.message
            : `I couldn't transcribe it: ${error instanceof Error ? error.message : String(error)}`;
        logger.warn("video.subtitles_failed", { error: String(error) });
      }
    }

    // After the probe, because how loud the bed sits and whether it ducks both
    // depend on whether the footage has its own audio at all.
    const music = input.music === false ? null : await prepareBed(dir, probed.hasAudio);

    await renderVertical(sourcePath, outputPath, decision.plan, probed, {
      startSeconds,
      sourceBytes: meta.sizeBytes,
      subtitlePath,
      music: music?.bed,
    });

    const rendered = await readFile(outputPath);
    const { size } = await stat(outputPath);

    const asset = await ingestFile({
      filename: slugForOutput(meta.name),
      mimeType: "video/mp4",
      data: rendered,
      source: `Google Drive: ${meta.name}`,
      description:
        (whatItShows
          ? `Vertical 9:16 cut of ${meta.name}. ${whatItShows}`
          : `Vertical 9:16 cut of ${meta.name}` +
            (decision.observations.length > 0 ? ` — ${decision.observations.slice(0, 3).join("; ")}` : "")) +
        (music ? ` Music: ${trackTitle(music.name)}.` : ""),
    });

    const outputSeconds = Math.min(REELS_MAX_SECONDS, available);
    // Stored on the asset rather than worked out at publish time, because by then
    // the track that was mixed in may have been changed or switched off.
    const audioName = audioNameFor(music?.name);

    // Recorded so a later "why does this one have bars?" has an answer, and so
    // the same source isn't re-rendered blindly.
    await prisma.asset.update({
      where: { id: asset.id },
      data: {
        metadata: {
          sizeBytes: size,
          driveFileId: input.driveFileId,
          sourceName: meta.name,
          sourceWidth: probed.width,
          sourceHeight: probed.height,
          reframeStrategy: decision.plan.strategy,
          reframeReason: decision.reason,
          startSeconds,
          outputSeconds,
          ...(music ? { musicTrack: music.name } : {}),
          ...(audioName ? { audioName } : {}),
        },
      },
    });

    await recordAudit({
      action: "video.prepared",
      entityType: "Asset",
      entityId: asset.id,
      actorType: "AI",
      details: { driveFileId: input.driveFileId, strategy: decision.plan.strategy, outputSeconds },
    });

    logger.info("video.prepared", {
      assetId: asset.id,
      strategy: decision.plan.strategy,
      sizeBytes: size,
      outputSeconds,
    });

    return {
      assetId: asset.id,
      whatItShows,
      transcript,
      subtitleProblem,
      filename: asset.filename,
      sourceName: meta.name,
      sourceShape: `${probed.width}x${probed.height}`,
      outputSeconds,
      sizeBytes: size,
      strategy: decision.plan.strategy,
      reason: decision.reason,
      observations: decision.observations,
      trimmedFromSeconds: trimmed ? probed.durationSeconds : undefined,
      startSeconds,
      musicTrack: music?.name,
      audioName,
    };
  });
}

/** Renders the outcome for Telegram and for the agent to read as a tool result. */
export function formatPreparedVideo(result: PreparedVideo): string {
  const lines = [
    `Ready: ${result.filename}`,
    `From ${result.sourceName} (${result.sourceShape}) → 1080x1920`,
    `${result.outputSeconds.toFixed(0)}s | ${(result.sizeBytes / 1024 / 1024).toFixed(1)}MB`,
    "",
    result.reason,
  ];

  if (result.musicTrack) {
    lines.push(
      "",
      `Music: ${trackTitle(result.musicTrack)} underneath` +
        (result.transcript || result.subtitleProblem ? ", ducked out of the way while you're talking" : "") +
        ".",
    );
  }

  if (result.subtitleProblem) {
    lines.push("", `No subtitles: ${result.subtitleProblem}`);
  } else if (result.transcript) {
    lines.push("", "Subtitles burned in. What it says:", `"${result.transcript.slice(0, 400)}"`);
  }

  if (result.trimmedFromSeconds) {
    lines.push(
      "",
      `The source is ${formatDuration(result.trimmedFromSeconds * 1000)} long and Instagram's API caps Reels at ` +
        `${REELS_MAX_SECONDS} seconds, so I used ${result.startSeconds === 0 ? "the first" : `${result.startSeconds}s in for`} ` +
        `${result.outputSeconds.toFixed(0)} seconds. Tell me a different start point if the good bit is elsewhere.`,
    );
  }

  lines.push("", `Asset id: ${result.assetId}`);
  return lines.join("\n");
}
