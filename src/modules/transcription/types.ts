/** One stretch of speech with the time it occupies, in seconds from the start. */
export interface TranscriptCue {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  cues: TranscriptCue[];
  /** Whole text, for writing captions against. */
  text: string;
  provider: string;
  /** Seconds of audio billed, for reporting what it cost. */
  durationSeconds: number;
}

export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export class TranscriptionNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionNotConfiguredError";
  }
}

/**
 * Described provider-neutrally on purpose. The choice between ElevenLabs,
 * Whisper via someone else's API, or a self-hosted model is about price and
 * where the audio goes, not about how the rest of the system works — and it is
 * a decision worth being able to reverse without touching anything but config.
 */
export interface TranscriptionProvider {
  readonly name: string;
  /** Cost per hour of audio, for reporting. Zero when self-hosted. */
  readonly costPerHourUsd: number;
  transcribe(audio: Buffer, filename: string): Promise<Transcript>;
}
