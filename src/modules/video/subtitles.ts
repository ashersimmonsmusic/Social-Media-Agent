import type { TranscriptCue } from "../transcription/types.js";
import { TARGET_HEIGHT, TARGET_WIDTH } from "./ffmpeg.js";

/**
 * Turns timed speech into a subtitle file ffmpeg can burn into the picture.
 *
 * ASS rather than SRT because SRT carries no styling: the player decides, and
 * burning it in means ffmpeg's defaults — small, white, centred, with a black
 * box behind it. That reads as a fansub, not as something Asher made.
 */

/**
 * Deliberately plain. The house style for burned-in captions on Reels is heavy
 * outlined text low in the frame — legible muted, out of the way of a face, and
 * not drawing attention to itself. No bouncing, no colour changes, no
 * word-by-word highlighting: those date fast and read as a template.
 */
const STYLE = {
  font: "DejaVu Sans",
  /** Large enough to read on a phone at arm's length in a 1920-tall frame. */
  sizePx: 58,
  /** Heavy outline rather than a box: it sits on the footage instead of over it. */
  outlinePx: 4,
  shadowPx: 1,
  /** Above the caption bar and the interface furniture at the bottom of a Reel. */
  marginBottomPx: 320,
  marginSidePx: 90,
};

/** ASS timestamps are H:MM:SS.cc — centiseconds, and a single-digit hour. */
export function assTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const centis = Math.round((clamped - Math.floor(clamped)) * 100);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(secs)}.${pad(Math.min(99, centis))}`;
}

/**
 * Escapes text for an ASS dialogue line.
 *
 * Braces open an override block and a newline ends the line early, so an
 * unescaped transcript could silently change the styling of everything after
 * it — or drop the rest of the caption.
 */
export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** Splits a long cue across two lines rather than letting it run off the frame. */
export function wrapCue(text: string, maxChars = 24): string {
  if (text.length <= maxChars) return text;

  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  // Two lines is the most that can be read before it has moved on.
  return lines.slice(0, 2).join("\\N");
}

export function buildAss(cues: TranscriptCue[]): string {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${TARGET_WIDTH}`,
    `PlayResY: ${TARGET_HEIGHT}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, " +
      "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // &H00FFFFFF white on &H00000000 black outline; alignment 2 is bottom-centre.
    `Style: Caption,${STYLE.font},${STYLE.sizePx},&H00FFFFFF,&H00000000,&H00000000,-1,0,1,` +
      `${STYLE.outlinePx},${STYLE.shadowPx},2,${STYLE.marginSidePx},${STYLE.marginSidePx},${STYLE.marginBottomPx},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events = cues
    .filter((cue) => cue.text.trim() && cue.end > cue.start)
    .map((cue) => {
      const text = wrapCue(escapeAssText(cue.text));
      return `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Caption,,0,0,0,,${text}`;
    });

  return [...header, ...events].join("\n");
}
