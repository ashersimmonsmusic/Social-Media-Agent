import { createSign } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { SERVICE_ACCOUNT_SCOPES } from "./scopes.js";

/**
 * Server-to-server access to Drive, as an alternative to asking Asher to
 * approve a consent screen.
 *
 * Google expires a user's authorisation seven days after consent while an OAuth
 * app is in "Testing", and leaving Testing means hosting a privacy policy on a
 * verified domain and passing review for a restricted scope. A service account
 * sidesteps all of it: it is a robot with its own email address, he shares one
 * folder with it the way he would with a person, and it signs its own tokens
 * from a private key. Nothing to re-approve, on any schedule.
 *
 * The trade is that it can only see what has been explicitly shared with it —
 * which is exactly the reach we wanted anyway.
 */

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKEN_LIFETIME_SECONDS = 3600;
/** Renew before expiry so a long operation can't die holding a stale token. */
const RENEW_MARGIN_MS = 5 * 60 * 1000;

export class ServiceAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceAccountError";
  }
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  let parsed: Partial<ServiceAccountKey>;
  try {
    parsed = JSON.parse(raw) as Partial<ServiceAccountKey>;
  } catch {
    throw new ServiceAccountError(
      "GOOGLE_SERVICE_ACCOUNT_JSON isn't valid JSON. Paste the whole contents of the key file Google gave you, " +
        "starting with { and ending with }.",
    );
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new ServiceAccountError(
      "That service account key is missing client_email or private_key. Download a fresh JSON key from Google and paste all of it.",
    );
  }

  // A key pasted through something that escapes newlines arrives with literal
  // backslash-n instead of line breaks, and signing fails with an opaque error.
  const privateKey = parsed.private_key.includes("\\n")
    ? parsed.private_key.replace(/\\n/g, "\n")
    : parsed.private_key;

  return { client_email: parsed.client_email, private_key: privateKey };
}

export function isServiceAccountConfigured(): boolean {
  return Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

/** The address Asher shares his folder with. Safe to show — it's not a secret. */
export function serviceAccountEmail(): string | null {
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  try {
    return parseServiceAccountKey(env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email;
  } catch {
    return null;
  }
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Builds the signed assertion Google exchanges for an access token. Exported so
 * a test can verify its shape without a network call.
 */
export function buildAssertion(key: ServiceAccountKey, issuedAt = Math.floor(Date.now() / 1000)): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: key.client_email,
      scope: SERVICE_ACCOUNT_SCOPES.join(" "),
      aud: TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + TOKEN_LIFETIME_SECONDS,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = base64Url(signer.sign(key.private_key));

  return `${header}.${claims}.${signature}`;
}

let cached: { token: string; expiresAt: number } | null = null;

export async function getServiceAccountToken(): Promise<string> {
  if (cached && cached.expiresAt - RENEW_MARGIN_MS > Date.now()) return cached.token;
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new ServiceAccountError("GOOGLE_SERVICE_ACCOUNT_JSON isn't set in Railway.");
  }

  const key = parseServiceAccountKey(env.GOOGLE_SERVICE_ACCOUNT_JSON);

  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: buildAssertion(key),
      }),
    });
  } catch (error) {
    throw new ServiceAccountError(`Couldn't reach Google to get a token: ${error instanceof Error ? error.message : error}`);
  }

  const json = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!response.ok || !json.access_token) {
    throw new ServiceAccountError(
      `Google refused the service account (${json.error_description ?? json.error ?? response.status}). ` +
        `Check the key is complete and that the Drive API is enabled on the project it belongs to.`,
    );
  }

  cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? TOKEN_LIFETIME_SECONDS) * 1000 };
  logger.info("oauth.service_account_token_issued");
  return json.access_token;
}

/** Exposed so a test starts from a known state. */
export function resetServiceAccountToken() {
  cached = null;
}
