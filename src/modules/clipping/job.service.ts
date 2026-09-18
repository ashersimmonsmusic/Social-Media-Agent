import type { Telegram } from "telegraf";
import { join } from "node:path";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../lib/logger.js";
import { sendPlainMessage } from "../../telegram/notify.js";
import { recordAudit } from "../audit/audit.service.js";
import { downloadToFile, getVideo } from "../drive/drive.service.js";
import { transcriber } from "../transcription/index.js";
import type { TranscriptCue } from "../transcription/types.js";
import { assertRoomFor, probe, withTempDir } from "../video/ffmpeg.js";
import { activeBed, prepareBed } from "../music/music.service.js";
import { cutClip, extractJobAudio } from "./cut.service.js";
import { analyseTranscript } from "./detect.service.js";

/**
 * Running one long video through the pipeline.
 *
 * The work takes tens of minutes, so every step commits its progress before the
 * next begins. A container that dies halfway is expected rather than
 * exceptional — Railway restarts on every deploy — and the transcript is stored
 * because it is the one step that costs money to repeat.
 */

/** How many of the best clips are rendered up front, so he can watch them. */
const CLIPS_TO_RENDER = 6;

/** Past this, a claim is assumed to belong to a container that no longer exists. */
const CLAIM_STALE_MS = 90 * 60 * 1000;

export class ClippingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClippingError";
  }
}

export async function queueVideo(driveFileId: string): Promise<{ id: string; filename: string; queued: boolean }> {
  const existing = await prisma.sourceVideo.findUnique({ where: { driveFileId } });
  if (existing) {
    return { id: existing.id, filename: existing.filename, queued: false };
  }

  const meta = await getVideo(driveFileId);
  const video = await prisma.sourceVideo.create({
    data: {
      driveFileId,
      filename: meta.name,
      durationSeconds: meta.durationMillis ? meta.durationMillis / 1000 : null,
      width: meta.width ?? null,
      height: meta.height ?? null,
      sizeBytes: BigInt(meta.sizeBytes),
    },
  });

  await recordAudit({
    action: "clipping.video_queued",
    entityType: "SourceVideo",
    entityId: video.id,
    actorType: "ASHER",
    details: { filename: meta.name, driveFileId },
  });

  return { id: video.id, filename: meta.name, queued: true };
}

/**
 * Takes ownership of one waiting video in a single conditional update, the same
 * way the post scheduler does — whichever caller's update reports a row wins,
 * so two containers cannot analyse the same video twice.
 */
async function claimNextVideo() {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MS);

  const candidate = await prisma.sourceVideo.findFirst({
    where: {
      OR: [
        { status: "QUEUED" },
        // A job whose container died mid-run. Its transcript survives, so
        // picking it up again is cheap.
        { status: { notIn: ["COMPLETE", "FAILED", "QUEUED"] }, claimedAt: { lt: staleBefore } },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;

  const { count } = await prisma.sourceVideo.updateMany({
    where: { id: candidate.id, status: candidate.status, claimedAt: candidate.claimedAt },
    data: { status: "DOWNLOADING", claimedAt: new Date(), failureReason: null },
  });
  return count === 1 ? candidate : null;
}

async function setStatus(id: string, status: "DOWNLOADING" | "EXTRACTING_AUDIO" | "TRANSCRIBING" | "ANALYSING" | "CUTTING", detail?: string) {
  await prisma.sourceVideo.update({ where: { id }, data: { status, statusDetail: detail ?? null, claimedAt: new Date() } });
}

interface StoredTranscript {
  cues: TranscriptCue[];
}

/** Runs one video end to end. Exported so a test can drive a single pass. */
export async function processVideo(videoId: string, telegram?: Telegram): Promise<void> {
  const video = await prisma.sourceVideo.findUnique({ where: { id: videoId } });
  if (!video) throw new ClippingError(`No video ${videoId}.`);

  await withTempDir(async (dir) => {
    const sourcePath = join(dir, "source");

    // The music bed lands in the same working directory as the source and every
    // clip cut from it, so its worst case is reserved before anything is fetched.
    const bedWanted = (await activeBed()) !== null;
    await assertRoomFor(
      Number(video.sizeBytes ?? 0),
      undefined,
      bedWanted ? env.MUSIC_MAX_TRACK_MB * 1024 * 1024 : 0,
    );

    await setStatus(videoId, "DOWNLOADING", `Fetching ${video.filename}`);
    await downloadToFile(video.driveFileId, sourcePath, env.VIDEO_MAX_SOURCE_MB * 1024 * 1024);

    const probed = await probe(sourcePath);
    await prisma.sourceVideo.update({
      where: { id: videoId },
      data: { durationSeconds: probed.durationSeconds, width: probed.width, height: probed.height },
    });

    // Reused when a job is picked up after a restart: transcription is the one
    // step that costs money, so it is never paid for twice.
    let cues = (video.transcript as unknown as StoredTranscript | null)?.cues ?? [];

    if (cues.length === 0) {
      if (!probed.hasAudio) {
        throw new ClippingError(
          `${video.filename} has no audio track, so there is nothing to read. Clipping works from what is said.`,
        );
      }

      await setStatus(videoId, "EXTRACTING_AUDIO", "Pulling the audio out");
      const audio = await extractJobAudio(sourcePath, dir);

      await setStatus(videoId, "TRANSCRIBING", `Transcribing ${Math.round(probed.durationSeconds / 60)} minutes`);
      const transcript = await transcriber().transcribe(audio, "source-audio.mp3");
      cues = transcript.cues;

      if (cues.length === 0) {
        throw new ClippingError(
          `I couldn't find any speech in ${video.filename}. Clipping works from what is said, so there's nothing for me to work with here.`,
        );
      }

      await prisma.sourceVideo.update({
        where: { id: videoId },
        data: { transcript: { cues } as object, transcriptText: transcript.text },
      });
    }

    await setStatus(videoId, "ANALYSING", "Reading it through");
    const scored = await analyseTranscript(cues, async (detail) => {
      await prisma.sourceVideo.update({ where: { id: videoId }, data: { statusDetail: detail, claimedAt: new Date() } });
    });

    if (scored.length === 0) {
      await prisma.sourceVideo.update({
        where: { id: videoId },
        data: { status: "COMPLETE", statusDetail: null, completedAt: new Date() },
      });
      if (telegram) {
        await sendPlainMessage(
          telegram,
          `I went through ${video.filename} and didn't find anything I'd defend as a standalone clip. ` +
            `That's a real answer rather than a failure — not every video has one in it.`,
        );
      }
      return;
    }

    // Replaced rather than appended, so a re-analysis doesn't leave the old
    // ranking sitting alongside the new one.
    await prisma.clip.deleteMany({ where: { sourceVideoId: videoId } });
    const clips = await prisma.$transaction(
      scored.map((clip, index) =>
        prisma.clip.create({
          data: {
            sourceVideoId: videoId,
            title: clip.title,
            startSeconds: clip.startSeconds,
            endSeconds: clip.endSeconds,
            transcript: clip.transcript,
            reason: clip.reason,
            score: clip.score,
            scores: clip.scores,
            rank: index + 1,
            topic: clip.topic ?? null,
            suggestedPlatforms: clip.suggestedPlatforms,
          },
        }),
      ),
    );

    await setStatus(videoId, "CUTTING", `Cutting the best ${Math.min(CLIPS_TO_RENDER, clips.length)}`);

    // Fetched once for the whole job rather than per clip: six clips means six
    // renders, and downloading the same track six times would be six times the
    // Drive quota for no difference in the output. Clipping only runs on footage
    // with speech in it, so the bed always ducks here.
    const music = await prepareBed(dir, true);

    let cut = 0;
    for (const clip of clips.slice(0, CLIPS_TO_RENDER)) {
      try {
        await cutClip({
          sourcePath,
          workDir: dir,
          clipId: clip.id,
          rank: clip.rank,
          title: clip.title,
          startSeconds: clip.startSeconds,
          endSeconds: clip.endSeconds,
          cues,
          subtitles: true,
          music: music?.bed,
          musicName: music?.name,
        });
        cut += 1;
        await prisma.sourceVideo.update({
          where: { id: videoId },
          data: { statusDetail: `Cut ${cut} of ${Math.min(CLIPS_TO_RENDER, clips.length)}`, claimedAt: new Date() },
        });
      } catch (error) {
        // One clip failing to render loses that clip, not the analysis. Its row
        // survives with no asset, and it can be cut again on request.
        logger.error("clipping.cut_failed", { clipId: clip.id, error: String(error) });
      }
    }

    await prisma.sourceVideo.update({
      where: { id: videoId },
      data: { status: "COMPLETE", statusDetail: null, completedAt: new Date() },
    });

    logger.info("clipping.video_complete", { videoId, clips: clips.length, cut });
    if (telegram) await sendPlainMessage(telegram, formatFinished(video.filename, clips, cut));

  });
}

export function formatFinished(
  filename: string,
  clips: { rank: number; title: string; score: number; endSeconds: number; startSeconds: number }[],
  cut: number,
): string {
  const top = clips.slice(0, 5).map((clip) => {
    const duration = Math.round(clip.endSeconds - clip.startSeconds);
    return `${String(clip.rank).padStart(2, "0")} — ${clip.title} — ${clip.score}/100 · ${duration}s`;
  });

  return [
    `NEW VIDEO ANALYSED — ${filename}`,
    "",
    `I found ${clips.length} clip${clips.length === 1 ? "" : "s"} worth your time. Top of the list:`,
    "",
    ...top,
    "",
    cut > 0
      ? `The best ${cut} are cut and ready to watch. Send /clips to see them.`
      : "None of them rendered, though — send /clips and I'll tell you why.",
  ].join("\n");
}

export async function markFailed(videoId: string, error: unknown): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error);
  await prisma.sourceVideo.update({
    where: { id: videoId },
    data: { status: "FAILED", failureReason: reason, statusDetail: null },
  });
  logger.error("clipping.video_failed", { videoId, error: reason });
}

/** Processes one waiting video, if there is one. Returns whether it did any work. */
export async function runNextClippingJob(telegram?: Telegram): Promise<boolean> {
  const claimed = await claimNextVideo();
  if (!claimed) return false;

  try {
    await processVideo(claimed.id, telegram);
  } catch (error) {
    await markFailed(claimed.id, error);
    if (telegram) {
      await sendPlainMessage(
        telegram,
        `I couldn't finish analysing ${claimed.filename}.\n\n${error instanceof Error ? error.message : String(error)}` +
          `\n\nSend /clips retry to try it again.`,
      );
    }
  }
  return true;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startClippingWorker(telegram: Telegram, intervalMs = 60_000) {
  if (timer) return;
  timer = setInterval(() => {
    // One at a time: two hour-long renders at once would exhaust the volume
    // this feature was only just given room on.
    if (running) return;
    running = true;
    void runNextClippingJob(telegram)
      .catch((error) => logger.error("clipping.worker_tick_failed", { error: String(error) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref?.();
  logger.info("clipping.worker_started", { intervalMs });
}

export function stopClippingWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
