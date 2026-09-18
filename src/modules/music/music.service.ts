import { join } from "node:path";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { clearSetting, getSetting, setSetting } from "../settings/setting.service.js";
import { downloadToFile, getTrack, DriveError } from "../drive/drive.service.js";
import type { MusicBed } from "../video/ffmpeg.js";

/**
 * The music bed: one chosen track, mixed into every clip the bot renders while
 * it is switched on.
 *
 * Instagram's publishing API cannot reach the app's music catalogue at all, so
 * "adding music to a post" can only mean putting the music in the file before
 * it is uploaded. That makes this the whole feature rather than a shortcut, and
 * it is why the track is Asher's own from his own Drive — which is also the only
 * kind of music he can bake in without a rights problem.
 */
const SETTING_KEY = "music.bed";

/** Quiet enough to sit under a voice without fighting it. */
export const DEFAULT_GAIN_DB = -14;
/**
 * Used instead when the footage is silent. The bed is then the entire
 * soundtrack, and -14dB of it sounds like a mistake rather than a choice.
 */
export const SILENT_SOURCE_GAIN_DB = -4;

/** Below this the bed is inaudible on a phone speaker; above it, it is the post. */
const MIN_GAIN_DB = -40;
const MAX_GAIN_DB = 0;

export interface StoredBed {
  driveFileId: string;
  /** Kept so the bot can say which track it is without a Drive call. */
  name: string;
  gainDb: number;
  startSeconds: number;
  /** False turns the bed off without forgetting which track was chosen. */
  enabled: boolean;
}

export class MusicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MusicError";
  }
}

/**
 * Reads the stored shape defensively.
 *
 * A row written by an older deploy is the expected case here, not a corruption:
 * it would otherwise reach ffmpeg as `volume=undefineddB` and fail the render
 * rather than the setting.
 */
export function parseStoredBed(value: unknown): StoredBed | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.driveFileId !== "string" || raw.driveFileId === "") return null;

  const gain = typeof raw.gainDb === "number" && Number.isFinite(raw.gainDb) ? raw.gainDb : DEFAULT_GAIN_DB;
  const start = typeof raw.startSeconds === "number" && Number.isFinite(raw.startSeconds) ? raw.startSeconds : 0;

  return {
    driveFileId: raw.driveFileId,
    name: typeof raw.name === "string" && raw.name !== "" ? raw.name : "a track",
    gainDb: clampGain(gain),
    startSeconds: Math.max(0, start),
    // Absent means on: a bed was only ever stored because it was being chosen.
    enabled: raw.enabled !== false,
  };
}

export function clampGain(gainDb: number): number {
  return Math.min(MAX_GAIN_DB, Math.max(MIN_GAIN_DB, Math.round(gainDb * 10) / 10));
}

export async function getBed(): Promise<StoredBed | null> {
  return getSetting(SETTING_KEY, parseStoredBed);
}

/** The bed to apply right now, or null when there is none or it is switched off. */
export async function activeBed(): Promise<StoredBed | null> {
  const bed = await getBed();
  return bed?.enabled ? bed : null;
}

export async function chooseTrack(driveFileId: string): Promise<StoredBed> {
  let name: string;
  try {
    name = (await getTrack(driveFileId)).name;
  } catch (error) {
    if (error instanceof DriveError) throw new MusicError(`I couldn't read that track from Drive: ${error.message}`);
    throw error;
  }

  // The level and offset survive a change of track: they are how he likes music
  // to sit, not a property of the file.
  const existing = await getBed();
  const bed: StoredBed = {
    driveFileId,
    name,
    gainDb: existing?.gainDb ?? DEFAULT_GAIN_DB,
    startSeconds: existing?.startSeconds ?? 0,
    enabled: true,
  };
  await setSetting(SETTING_KEY, bed);
  logger.info("music.bed_chosen", { driveFileId, gainDb: bed.gainDb });
  return bed;
}

/** Changes one field of the stored bed. Fails cleanly when no track is chosen. */
export async function updateBed(changes: Partial<Pick<StoredBed, "gainDb" | "startSeconds" | "enabled">>): Promise<StoredBed> {
  const existing = await getBed();
  if (!existing) throw new MusicError("No track is chosen yet. Send /music and tap one.");

  const bed: StoredBed = {
    ...existing,
    ...changes,
    ...(changes.gainDb !== undefined ? { gainDb: clampGain(changes.gainDb) } : {}),
    ...(changes.startSeconds !== undefined ? { startSeconds: Math.max(0, changes.startSeconds) } : {}),
  };
  await setSetting(SETTING_KEY, bed);
  return bed;
}

export async function forgetBed(): Promise<boolean> {
  return clearSetting(SETTING_KEY);
}

/**
 * Fetches the chosen track into a render's working directory and describes how
 * to mix it.
 *
 * Returns null rather than throwing when there is no bed, so every caller can
 * ask for one unconditionally. A bed that is chosen but unfetchable *does*
 * throw — silently publishing a clip without the music he asked for is worse
 * than stopping.
 */
export async function prepareBed(
  workDir: string,
  hasSourceAudio: boolean,
): Promise<{ bed: MusicBed; name: string } | null> {
  const stored = await activeBed();
  if (!stored) return null;

  const path = join(workDir, "bed");
  try {
    await downloadToFile(stored.driveFileId, path, env.MUSIC_MAX_TRACK_MB * 1024 * 1024);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MusicError(
      `I couldn't fetch ${stored.name} to put under this clip: ${detail}\n\n` +
        `Turn the bed off with /music off if you want to post without it.`,
    );
  }

  return {
    name: stored.name,
    bed: {
      path,
      // A silent clip needs the bed loud enough to be the soundtrack; one with a
      // voice in it needs the bed underneath, and ducked out of the way.
      gainDb: hasSourceAudio ? stored.gainDb : Math.max(stored.gainDb, SILENT_SOURCE_GAIN_DB),
      startSeconds: stored.startSeconds,
      duck: hasSourceAudio,
    },
  };
}

/** The track name with the extension off, for a caption or an audio label. */
export function trackTitle(name: string): string {
  return name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || "Original audio";
}

/**
 * What Instagram should call this Reel's audio.
 *
 * `audio_name` is the only music-adjacent thing the publishing API accepts, and
 * it names the Reel's *own* audio rather than choosing a track. For music Asher
 * wrote, that is the difference between an unnamed blob and a tappable audio
 * page other people can post with — so it is worth setting even though it adds
 * no sound.
 */
export function audioNameFor(trackName?: string): string | undefined {
  const artist = env.INSTAGRAM_AUDIO_NAME?.trim();
  const title = trackName ? trackTitle(trackName) : undefined;

  if (title && artist) return `${title} · ${artist}`.slice(0, AUDIO_NAME_MAX);
  return (title ?? artist)?.slice(0, AUDIO_NAME_MAX);
}

/**
 * Instagram documents no limit, so this is a guess at a safe one rather than the
 * real ceiling — long enough for "Title · Artist" and short enough that a
 * rejection here can't be what fails a publish.
 */
const AUDIO_NAME_MAX = 80;

export function formatBed(bed: StoredBed | null): string {
  if (!bed) {
    return [
      "No music bed set.",
      "",
      "Send /music to see the tracks in your Drive and tap one. I'll mix it under every clip I render,",
      "ducked out of the way whenever you're talking.",
    ].join("\n");
  }

  return [
    `Track: ${trackTitle(bed.name)}`,
    `Level: ${bed.gainDb}dB${bed.gainDb === DEFAULT_GAIN_DB ? " (default)" : ""}`,
    bed.startSeconds > 0 ? `Starts: ${bed.startSeconds}s into the track` : "Starts: from the top",
    `Currently: ${bed.enabled ? "on — every clip I render gets it" : "off"}`,
  ].join("\n");
}
