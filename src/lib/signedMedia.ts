import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Instagram fetches the image within moments of the container call, so a short
 * window is plenty. Anything longer just widens how long a leaked URL works.
 */
const DEFAULT_TTL_SECONDS = 60 * 60;

export class MediaUrlUnavailableError extends Error {
  constructor(missing: string) {
    super(
      `I can't build a public image link because ${missing} isn't set in Railway. ` +
        `Instagram fetches images over the internet, so it needs one.`,
    );
    this.name = "MediaUrlUnavailableError";
  }
}

function signingSecret(): string {
  if (!env.SOCIAL_TOKEN_KEY) throw new MediaUrlUnavailableError("SOCIAL_TOKEN_KEY");
  // Labelled so this signature can never be confused with a token ciphertext.
  return `media-url:${env.SOCIAL_TOKEN_KEY}`;
}

function signature(assetId: string, expires: number): string {
  return createHmac("sha256", signingSecret()).update(`${assetId}.${expires}`).digest("hex");
}

/**
 * Builds a time-limited public URL for one asset.
 *
 * The library holds unreleased material, so the media route is not a plain
 * public directory: each link names a single asset, expires, and carries an
 * HMAC, meaning a guessed or stale URL gets nothing.
 */
export function signedMediaUrl(assetId: string, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  if (!env.PUBLIC_BASE_URL) throw new MediaUrlUnavailableError("PUBLIC_BASE_URL");
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return `${base}/media/${assetId}?expires=${expires}&signature=${signature(assetId, expires)}`;
}

export function verifyMediaSignature(assetId: string, expires: number, provided: string): boolean {
  if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;

  const expected = Buffer.from(signature(assetId, expires), "utf8");
  const actual = Buffer.from(provided, "utf8");
  // Length check first: timingSafeEqual throws on a length mismatch.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
