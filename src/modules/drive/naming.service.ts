import { join } from "node:path";
import { aiService } from "../../ai/AIService.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../db/prisma.js";
import { assertRoomFor, extractFrames, probe, withTempDir } from "../video/ffmpeg.js";
import { downloadToFile, getVideo } from "./drive.service.js";

/**
 * Working out what a video should be called.
 *
 * Footage arrives named by the camera — 00066.MTS, 1547174371597.mp4 — which
 * makes a Drive folder unsearchable within about a month. The bot already
 * learns what is in a clip when it analyses or reframes one; this puts that to
 * use rather than leaving the knowledge in a log.
 */

/**
 * Names are for finding things in a list six months later, not for a feed. The
 * failure mode to guard against is a model writing a title — evocative, vague,
 * and useless when you are scrolling a folder looking for the right take.
 */
const NAMING_PROMPT = `You are naming a video file belonging to Asher Simmons, an independent musician in Bristol, so he can find it in his Drive months from now.

Write ONE short name. Rules:

- Describe what the footage IS, concretely: what happens, where, who or what is in it.
- Lead with the most identifying thing. "Louisiana live set" beats "Live footage at the Louisiana".
- Between three and eight words. No punctuation beyond spaces and hyphens.
- No file extension — that is kept automatically.
- British English.
- This is a label, not a title. No marketing, no mood words, nothing evocative. "Studio session working out the bridge" is right; "Finding the magic" is not.
- If you genuinely cannot tell what it is, say exactly: UNKNOWN

Return only the name, nothing else.`;

/** Enough to tell a studio from a stage without paying to look at an hour. */
const FRAMES_TO_SAMPLE = 5;

export class NamingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NamingError";
  }
}

function clean(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A name from the transcript, where the video has already been analysed.
 *
 * Far better material than frames, and free — what someone says in the first
 * few minutes identifies a session more reliably than what it looks like.
 */
export async function suggestFromTranscript(driveFileId: string): Promise<string | null> {
  const analysed = await prisma.sourceVideo.findUnique({ where: { driveFileId } });
  const transcript = analysed?.transcriptText?.trim();
  if (!transcript) return null;

  const result = await aiService.generate(
    "CAPTION",
    `Filename now: ${analysed!.filename}\n\nWhat is said in it:\n${transcript.slice(0, 6000)}`,
    { system: NAMING_PROMPT, maxTokens: 200 },
  );

  const name = clean(result.text);
  return name && name.toUpperCase() !== "UNKNOWN" ? name : null;
}

/**
 * A name from a handful of frames, for footage nothing has read yet.
 *
 * Costs a download, so it is the fallback rather than the default.
 */
export async function suggestFromFrames(driveFileId: string): Promise<string | null> {
  const meta = await getVideo(driveFileId);

  return withTempDir(async (dir) => {
    await assertRoomFor(meta.sizeBytes);
    const sourcePath = join(dir, "source");
    await downloadToFile(driveFileId, sourcePath, env.VIDEO_MAX_SOURCE_MB * 1024 * 1024);

    const probed = await probe(sourcePath);
    const frames = await extractFrames(sourcePath, probed.durationSeconds, FRAMES_TO_SAMPLE);

    const result = await aiService.generate(
      "VISION",
      `Filename now: ${meta.name}. ${frames.length} stills, evenly spaced through a ${Math.round(probed.durationSeconds / 60)}-minute video.`,
      {
        system: NAMING_PROMPT,
        maxTokens: 200,
        attachments: frames.map((data, index) => ({
          kind: "image" as const,
          mediaType: "image/jpeg",
          data,
          filename: `frame-${index + 1}.jpg`,
        })),
      },
    );

    const name = clean(result.text);
    return name && name.toUpperCase() !== "UNKNOWN" ? name : null;
  });
}

export interface NameSuggestion {
  name: string;
  /** Where it came from, so he knows how much to trust it. */
  basis: "transcript" | "frames";
}

/**
 * Suggests a name, cheaply where possible.
 *
 * The transcript is tried first because it is free and better. Falling back to
 * frames means downloading the video, so callers should say that is happening.
 */
export async function suggestName(driveFileId: string, allowDownload = true): Promise<NameSuggestion | null> {
  try {
    const fromTranscript = await suggestFromTranscript(driveFileId);
    if (fromTranscript) return { name: fromTranscript, basis: "transcript" };
  } catch (error) {
    logger.warn("naming.transcript_failed", { driveFileId, error: String(error) });
  }

  if (!allowDownload) return null;

  try {
    const fromFrames = await suggestFromFrames(driveFileId);
    return fromFrames ? { name: fromFrames, basis: "frames" } : null;
  } catch (error) {
    logger.warn("naming.frames_failed", { driveFileId, error: String(error) });
    throw new NamingError(
      `I couldn't work out what that video is: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** True when a filename carries no information — the case worth offering to fix. */
export function looksUnnamed(filename: string): boolean {
  const base = filename.replace(/\.[^.]+$/, "");
  // Camera and phone output: all digits, or a short prefix and a run of digits.
  return /^\d+$/.test(base) || /^[A-Za-z]{0,4}[_-]?\d{4,}$/.test(base) || base.length <= 3;
}
