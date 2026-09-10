import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export class MissingTokenKeyError extends Error {
  constructor() {
    super(
      "SOCIAL_TOKEN_KEY isn't set, so I can't store an access token safely. " +
        "Generate one with `openssl rand -hex 32` and add it in Railway.",
    );
    this.name = "MissingTokenKeyError";
  }
}

function encryptionKey(): Buffer {
  const raw = env.SOCIAL_TOKEN_KEY;
  if (!raw) throw new MissingTokenKeyError();

  const key = /^[0-9a-f]{64}$/i.test(raw.trim()) ? Buffer.from(raw.trim(), "hex") : Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) {
    throw new Error(`SOCIAL_TOKEN_KEY must decode to 32 bytes, got ${key.length}. Use \`openssl rand -hex 32\`.`);
  }
  return key;
}

/**
 * Encrypts a platform access token for storage. A posting token is equivalent
 * to account access, so it never goes into the database in plaintext — a
 * database dump or a stray log line would otherwise hand it over.
 *
 * Format is `iv:authTag:ciphertext`, each base64. GCM's auth tag means tampering
 * with a stored row fails loudly on decrypt rather than yielding garbage.
 */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptToken(stored: string): string {
  const [ivB64, tagB64, ciphertextB64] = stored.split(":");
  if (!ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error("Stored access token isn't in the expected iv:tag:ciphertext format.");
  }

  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]).toString("utf8");
}

/** Last four characters, for showing which token is stored without revealing it. */
export function tokenHint(plaintext: string): string {
  return plaintext.length <= 4 ? "****" : `…${plaintext.slice(-4)}`;
}
