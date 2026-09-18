import { ElevenLabsProvider } from "./elevenlabs.provider.js";
import type { TranscriptionProvider } from "./types.js";

/**
 * Only one provider today, behind the interface anyway.
 *
 * The choice is about price and where the audio is sent, not about how anything
 * else works, and it is worth being able to change without touching the code
 * that uses it — a self-hosted Whisper or a cheaper API is the same shape.
 */
export function transcriber(): TranscriptionProvider {
  return new ElevenLabsProvider();
}

export type { Transcript, TranscriptCue, TranscriptionProvider } from "./types.js";
