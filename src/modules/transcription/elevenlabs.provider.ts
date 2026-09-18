import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { TranscriptionError, TranscriptionNotConfiguredError, type Transcript, type TranscriptCue, type TranscriptionProvider } from "./types.js";

const ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";

/** Published pay-as-you-go rate, used only to tell Asher what a clip cost. */
const COST_PER_HOUR_USD = 0.22;

/** Long enough for a 90-second clip on a slow link, short enough to fail a hang. */
const TIMEOUT_MS = 4 * 60 * 1000;

interface ScribeWord {
  text?: string;
  start?: number;
  end?: number;
  type?: string;
}

/**
 * Groups word timings into subtitle-sized cues.
 *
 * Word-level timings are what the API returns and what makes karaoke-style
 * captions possible, but a subtitle is read in phrases: one word at a time is
 * exhausting, and a whole sentence sits on screen too long to track. Breaking
 * on a real pause keeps the grouping close to how the line was actually spoken.
 */
export function groupWordsIntoCues(words: ScribeWord[], maxChars = 42, pauseSeconds = 0.4): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  let current: { start: number; end: number; parts: string[] } | null = null;

  for (const word of words) {
    const text = (word.text ?? "").trim();
    if (!text || word.type === "spacing") continue;
    const start: number = typeof word.start === "number" ? word.start : (current?.end ?? 0);
    const end: number = typeof word.end === "number" ? word.end : start;

    if (!current) {
      current = { start, end, parts: [text] };
      continue;
    }

    const wouldBe = [...current.parts, text].join(" ");
    const gap = start - current.end;
    // A pause is a better break than a character count, so it wins.
    if (gap >= pauseSeconds || wouldBe.length > maxChars) {
      cues.push({ start: current.start, end: current.end, text: current.parts.join(" ") });
      current = { start, end, parts: [text] };
      continue;
    }

    current.parts.push(text);
    current.end = end;
  }

  if (current) cues.push({ start: current.start, end: current.end, text: current.parts.join(" ") });
  return cues;
}

export class ElevenLabsProvider implements TranscriptionProvider {
  readonly name = "elevenlabs";
  readonly costPerHourUsd = COST_PER_HOUR_USD;

  async transcribe(audio: Buffer, filename: string): Promise<Transcript> {
    if (!env.ELEVENLABS_API_KEY) {
      throw new TranscriptionNotConfiguredError(
        "ELEVENLABS_API_KEY isn't set in Railway, so I can't transcribe anything. " +
          "Get one from elevenlabs.io under your profile — it's a key, so it goes in Railway and nowhere else.",
      );
    }

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/mpeg" }), filename);
    form.append("model_id", env.ELEVENLABS_STT_MODEL);
    // Word timings are what make it possible to put the right words on screen
    // at the right moment rather than a block of text over the whole clip.
    form.append("timestamps_granularity", "word");
    form.append("diarize", "false");

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TranscriptionError(
        detail.includes("timed out") || detail.includes("abort")
          ? "Transcription took too long and I stopped waiting."
          : `Couldn't reach ElevenLabs: ${detail}`,
      );
    }

    const body = await response.text();
    if (!response.ok) {
      let detail = body.slice(0, 300);
      try {
        const parsed = JSON.parse(body) as { detail?: { message?: string } | string };
        detail = typeof parsed.detail === "string" ? parsed.detail : (parsed.detail?.message ?? detail);
      } catch {
        // keep the raw body
      }
      throw new TranscriptionError(
        response.status === 401
          ? "ElevenLabs rejected the API key. Check ELEVENLABS_API_KEY in Railway."
          : `ElevenLabs refused to transcribe that (${response.status}): ${detail}`,
      );
    }

    let json: { text?: string; words?: ScribeWord[] };
    try {
      json = JSON.parse(body) as typeof json;
    } catch {
      throw new TranscriptionError("ElevenLabs sent back something I couldn't read.");
    }

    const cues = groupWordsIntoCues(json.words ?? []);
    const durationSeconds = cues.length > 0 ? cues[cues.length - 1]!.end : 0;
    logger.info("transcription.completed", { provider: this.name, cues: cues.length, durationSeconds });

    return {
      cues,
      text: (json.text ?? cues.map((cue) => cue.text).join(" ")).trim(),
      provider: this.name,
      durationSeconds,
    };
  }
}
