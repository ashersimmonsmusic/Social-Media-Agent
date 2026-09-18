import { aiService } from "../../ai/AIService.js";
import { logger } from "../../lib/logger.js";
import type { TranscriptCue } from "../transcription/types.js";
import { clippingBrief, titleBrief, CRITERIA } from "./craft.js";
import { buildWindows, snapToSpeech, type TranscriptWindow } from "./transcript.js";

/**
 * Finding the moments worth cutting.
 *
 * Two passes rather than one. The first reads the transcript and proposes
 * candidates — a model doing this and scoring simultaneously reaches for a
 * number to justify a choice it has already made. The second sees all the
 * candidates together, which is the only way to judge whether one is a weaker
 * version of another, and the only way a score means anything relative.
 */

/** The brief's lengths. Anything outside this is not a short-form clip. */
export const MIN_CLIP_SECONDS = 12;
export const MAX_CLIP_SECONDS = 90;

export interface Candidate {
  startSeconds: number;
  endSeconds: number;
  title: string;
  reason: string;
  transcript: string;
  topic?: string;
}

export interface ScoredClip extends Candidate {
  score: number;
  scores: Record<string, number>;
  suggestedPlatforms: string[];
}

const FIND_PROMPT = `You are finding moments worth cutting into short-form clips from a video by Asher Simmons, an independent musician in Bristol. You have the transcript with timestamps. Nobody can watch the video.

${clippingBrief()}

${titleBrief()}

Timestamps in the transcript are [MM:SS] from the start of the video. Give start and end in SECONDS from the start of the video.

A clip runs ${MIN_CLIP_SECONDS}-${MAX_CLIP_SECONDS} seconds. Do not force them to a single length — take the length the moment actually needs. Start close to the hook, not at the polite introduction before it. End after the point lands.

Propose only moments you would genuinely defend. Six strong ones beat twenty padded out. If this stretch of transcript contains nothing worth cutting, return an empty list — that is a real and useful answer.

Return ONLY this JSON, no prose and no code fences:
{"candidates":[{"start":<seconds>,"end":<seconds>,"title":"<short, describes the content>","reason":"<one sentence: why this stands alone>","topic":"<two or three words>"}]}`;

const SCORE_PROMPT = `You are ranking candidate clips from one video by Asher Simmons against each other, so the best surface first.

${clippingBrief()}

You are seeing every candidate at once. Two jobs beyond scoring:

1. Where several candidates make essentially the same point, keep the strongest and drop the rest. Say in its reason that a weaker version existed.
2. Drop anything that fails the rejection rules outright, however interesting the subject.

Score each surviving candidate 0-100 on each criterion, and give an overall 0-100. The overall is your judgement, not an average — a clip that fails "independence" cannot be rescued by good audio.

Also say which platforms suit it. Not every clip belongs everywhere: a 70-second story suits Reels and Shorts; a 15-second punchline suits TikTok; something that reads better as a quote may suit none of them. Use only these names: instagram, tiktok, youtube, facebook, x.

Return ONLY this JSON, no prose and no code fences:
{"clips":[{"index":<the candidate's number>,"score":<0-100>,"scores":{${CRITERIA.map(([key]) => `"${key}":<0-100>`).join(",")}},"reason":"<one or two sentences, in plain words, on why it scored as it did>","platforms":["instagram"]}]}`;

function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseCandidates(raw: string, cues: TranscriptCue[]): Candidate[] {
  const parsed = extractJson(raw);
  if (!parsed || !Array.isArray(parsed.candidates)) return [];

  return (parsed.candidates as unknown[]).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const start = Number(row.start);
    const end = Number(row.end);
    const title = typeof row.title === "string" ? row.title.trim() : "";
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !title) return [];

    // Snapped here rather than at cut time: a candidate whose real length falls
    // outside the range once it lands on speech boundaries was never viable,
    // and should be dropped before anyone spends a model call scoring it.
    const snapped = snapToSpeech(cues, start, end);
    const duration = snapped.end - snapped.start;
    if (duration < MIN_CLIP_SECONDS || duration > MAX_CLIP_SECONDS) return [];

    return [
      {
        startSeconds: snapped.start,
        endSeconds: snapped.end,
        title,
        reason: typeof row.reason === "string" ? row.reason.trim() : "",
        transcript: snapped.text,
        topic: typeof row.topic === "string" ? row.topic.trim() || undefined : undefined,
      },
    ];
  });
}

/**
 * Drops candidates that cover nearly the same stretch of video.
 *
 * Overlapping windows mean the same moment is usually proposed twice, once by
 * each window that could see it. That is a mechanical duplicate rather than a
 * judgement, so it is removed before the model is asked to think about
 * anything.
 */
export function dedupeByOverlap(candidates: Candidate[], threshold = 0.6): Candidate[] {
  const kept: Candidate[] = [];

  for (const candidate of [...candidates].sort((a, b) => a.startSeconds - b.startSeconds)) {
    const duplicate = kept.find((existing) => {
      const overlap =
        Math.min(existing.endSeconds, candidate.endSeconds) - Math.max(existing.startSeconds, candidate.startSeconds);
      if (overlap <= 0) return false;
      const shorter = Math.min(
        existing.endSeconds - existing.startSeconds,
        candidate.endSeconds - candidate.startSeconds,
      );
      return overlap / shorter >= threshold;
    });
    if (!duplicate) kept.push(candidate);
  }

  return kept;
}

const PLATFORMS = ["instagram", "tiktok", "youtube", "facebook", "x"];

export function parseScores(raw: string, candidates: Candidate[]): ScoredClip[] {
  const parsed = extractJson(raw);
  if (!parsed || !Array.isArray(parsed.clips)) return [];

  const clamp = (value: unknown) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

  return (parsed.clips as unknown[]).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const index = Number(row.index);
    // One-based in the prompt, because a model counting from zero gets it wrong
    // often enough to matter.
    const candidate = candidates[index - 1];
    if (!candidate) return [];

    const scores: Record<string, number> = {};
    const raw_scores = (row.scores ?? {}) as Record<string, unknown>;
    for (const [key] of CRITERIA) scores[key] = clamp(raw_scores[key]);

    const platforms = Array.isArray(row.platforms)
      ? (row.platforms as unknown[])
          .filter((name): name is string => typeof name === "string")
          .map((name) => name.toLowerCase().trim())
          .filter((name) => PLATFORMS.includes(name))
      : [];

    return [
      {
        ...candidate,
        score: clamp(row.score),
        scores,
        reason: typeof row.reason === "string" && row.reason.trim() ? row.reason.trim() : candidate.reason,
        suggestedPlatforms: platforms,
      },
    ];
  });
}

/** Finds candidates across one window. Exported so a window can be reanalysed alone. */
export async function findInWindow(window: TranscriptWindow, cues: TranscriptCue[]): Promise<Candidate[]> {
  const result = await aiService.generate(
    "STRATEGY",
    `Transcript from ${Math.round(window.startSeconds)}s to ${Math.round(window.endSeconds)}s of the video:\n\n${window.text}`,
    { system: FIND_PROMPT, maxTokens: 4096 },
  );
  return parseCandidates(result.text, cues);
}

export async function scoreCandidates(candidates: Candidate[]): Promise<ScoredClip[]> {
  if (candidates.length === 0) return [];

  const listed = candidates
    .map(
      (candidate, index) =>
        `${index + 1}. [${Math.round(candidate.startSeconds)}s-${Math.round(candidate.endSeconds)}s, ` +
        `${Math.round(candidate.endSeconds - candidate.startSeconds)}s] "${candidate.title}"\n` +
        `   why it was proposed: ${candidate.reason}\n` +
        `   what is said: ${candidate.transcript.slice(0, 600)}`,
    )
    .join("\n\n");

  const result = await aiService.generate("STRATEGY", `${candidates.length} candidates:\n\n${listed}`, {
    system: SCORE_PROMPT,
    maxTokens: 8192,
  });

  return parseScores(result.text, candidates).sort((a, b) => b.score - a.score);
}

/**
 * The whole analysis, transcript in and ranked clips out.
 *
 * No video is touched here, which is what makes it cheap to run and possible to
 * test against a transcript alone.
 */
export async function analyseTranscript(
  cues: TranscriptCue[],
  onProgress?: (detail: string) => Promise<void>,
): Promise<ScoredClip[]> {
  const windows = buildWindows(cues);
  const found: Candidate[] = [];

  for (const [index, window] of windows.entries()) {
    await onProgress?.(`Reading part ${index + 1} of ${windows.length}`);
    try {
      found.push(...(await findInWindow(window, cues)));
    } catch (error) {
      // One bad window should not lose the rest of an hour's analysis.
      logger.error("clipping.window_failed", { index, error: String(error) });
    }
  }

  const unique = dedupeByOverlap(found);
  logger.info("clipping.candidates_found", { raw: found.length, unique: unique.length, windows: windows.length });
  if (unique.length === 0) return [];

  await onProgress?.(`Ranking ${unique.length} moments`);
  return scoreCandidates(unique);
}
