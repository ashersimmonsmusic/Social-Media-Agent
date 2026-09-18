import type { TranscriptCue } from "../transcription/types.js";

/**
 * Turning a list of timed phrases into something a model can reason about, and
 * turning its answers back into timestamps.
 *
 * An hour of speech is far too much to hand over at once, so it goes in
 * overlapping windows. The overlap matters: a moment that straddles a boundary
 * would otherwise be invisible to both halves.
 */

/** Roughly ten minutes of speech per window, which fits comfortably in context. */
export const WINDOW_SECONDS = 600;
/** Enough that no plausible clip falls entirely into a seam. */
export const OVERLAP_SECONDS = 90;

export interface TranscriptWindow {
  startSeconds: number;
  endSeconds: number;
  /** Timestamped lines, so the model can quote back a start and end. */
  text: string;
}

function stamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

/** `[MM:SS] text` per line — the timestamps are how a clip gets located. */
export function renderCues(cues: TranscriptCue[]): string {
  return cues.map((cue) => `[${stamp(cue.start)}] ${cue.text}`).join("\n");
}

export function buildWindows(
  cues: TranscriptCue[],
  windowSeconds = WINDOW_SECONDS,
  overlapSeconds = OVERLAP_SECONDS,
): TranscriptWindow[] {
  if (cues.length === 0) return [];

  const duration = cues[cues.length - 1]!.end;
  if (duration <= windowSeconds) {
    return [{ startSeconds: 0, endSeconds: duration, text: renderCues(cues) }];
  }

  const windows: TranscriptWindow[] = [];
  const step = Math.max(1, windowSeconds - overlapSeconds);

  for (let start = 0; start < duration; start += step) {
    const end = Math.min(duration, start + windowSeconds);
    const slice = cues.filter((cue) => cue.end > start && cue.start < end);
    if (slice.length > 0) {
      windows.push({ startSeconds: start, endSeconds: end, text: renderCues(slice) });
    }
    if (end >= duration) break;
  }

  return windows;
}

/**
 * Snaps a proposed cut to the nearest natural boundary.
 *
 * A model asked for a timestamp gives a round number, and a round number lands
 * mid-word. Real starts and ends are where speech actually begins and stops,
 * which the word timings already know.
 */
export function snapToSpeech(
  cues: TranscriptCue[],
  startSeconds: number,
  endSeconds: number,
  paddingBefore = 0.25,
  paddingAfter = 0.6,
): { start: number; end: number; text: string } {
  if (cues.length === 0) return { start: startSeconds, end: endSeconds, text: "" };

  // The first cue that begins at or after the request, else the one containing it.
  const startCue =
    cues.find((cue) => cue.start >= startSeconds - 0.5) ??
    cues.find((cue) => cue.end > startSeconds) ??
    cues[0]!;

  const inRange = cues.filter((cue) => cue.start >= startCue.start && cue.start <= endSeconds + 0.5);
  // Ending on the last cue that starts inside the range keeps the final thought
  // whole rather than clipping its last word.
  const endCue = inRange.length > 0 ? inRange[inRange.length - 1]! : startCue;

  return {
    // Padding, because cutting exactly on the first phoneme sounds abrupt.
    start: Math.max(0, startCue.start - paddingBefore),
    // And after, because a reaction often lands once the talking stops.
    end: endCue.end + paddingAfter,
    text: inRange.map((cue) => cue.text).join(" ").trim() || startCue.text,
  };
}
