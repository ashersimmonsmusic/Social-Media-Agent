import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { decryptToken, encryptToken } from "../../lib/tokenCrypto.js";
import { logger } from "../../lib/logger.js";
import { recordAudit } from "../audit/audit.service.js";

/**
 * Read-only. The bot needs to list and fetch Asher's videos and nothing more —
 * a wider scope would let a mistake here delete his footage.
 */
export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly", "openid", "email"];

/** Refresh this far before actual expiry, so a long operation doesn't die mid-way. */
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

/** The connect link is short-lived — it authorises access to his whole Drive. */
const STATE_TTL_MS = 10 * 60 * 1000;

export class GoogleNotConfiguredError extends Error {
  /**
   * Names the variables that are actually absent, not all three.
   *
   * PUBLIC_BASE_URL is shared with Instagram's media links, so a message
   * implying it needs setting when it is already correct invites someone to
   * overwrite a working value and break posting while fixing Drive.
   */
  constructor(missing: string[]) {
    const list = missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)!}`;
    super(
      `Google isn't set up yet — ${list} ${missing.length === 1 ? "needs" : "need"} setting in Railway. ` +
        `DRIVE_SETUP.md walks through where ${missing.length === 1 ? "it comes" : "they come"} from.`,
    );
    this.name = "GoogleNotConfiguredError";
  }
}

export class GoogleNotConnectedError extends Error {
  constructor() {
    super("Google Drive isn't connected. Run /drive to get a link.");
    this.name = "GoogleNotConnectedError";
  }
}

/**
 * Google's stored permission has stopped working and only Asher can restore it.
 *
 * Distinct from "never connected" because the remedy reads differently: this one
 * worked yesterday. The usual cause is an OAuth app still in Testing, where
 * Google expires the refresh token after seven days — see DRIVE_SETUP.md.
 */
export class GoogleReauthRequiredError extends Error {
  constructor(detail: string) {
    super(
      `Google has stopped accepting my saved permission (${detail}). Run /drive to reconnect — it takes a few seconds. ` +
        `If this keeps happening every week, your Google app is still set to "Testing"; DRIVE_SETUP.md says how to fix it for good.`,
    );
    this.name = "GoogleReauthRequiredError";
  }
}

function config() {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  const base = env.PUBLIC_BASE_URL;

  const missing = [
    !clientId && "GOOGLE_CLIENT_ID",
    !clientSecret && "GOOGLE_CLIENT_SECRET",
    !base && "PUBLIC_BASE_URL",
  ].filter((name): name is string => typeof name === "string");
  if (missing.length > 0) throw new GoogleNotConfiguredError(missing);

  return { clientId: clientId!, clientSecret: clientSecret!, redirectUri: `${base!.replace(/\/$/, "")}/oauth/google/callback` };
}

/**
 * The callback is a public URL Google redirects to, so the `state` it carries
 * is the only thing proving the flow was started from Asher's chat rather than
 * by someone who guessed the URL. Signed and time-limited for that reason.
 */
function signState(issuedAt: number): string {
  const secret = env.SOCIAL_TOKEN_KEY ?? env.ADMIN_API_KEY;
  return createHmac("sha256", `google-oauth:${secret}`).update(String(issuedAt)).digest("hex");
}

export function createState(): string {
  const issuedAt = Date.now();
  return `${issuedAt}.${signState(issuedAt)}`;
}

export function verifyState(state: string): boolean {
  const [issuedRaw, provided] = state.split(".");
  const issuedAt = Number(issuedRaw);
  if (!issuedRaw || !provided || !Number.isFinite(issuedAt)) return false;
  if (Date.now() - issuedAt > STATE_TTL_MS || issuedAt > Date.now() + 60_000) return false;

  const expected = Buffer.from(signState(issuedAt), "utf8");
  const actual = Buffer.from(provided, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function authorisationUrl(): string {
  const { clientId, redirectUri } = config();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DRIVE_SCOPES.join(" "));
  // Google only returns a refresh token when asked explicitly, and only on the
  // first consent unless prompted again — without both, access dies in an hour.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", createState());
  return url.toString();
}

interface TokenResponse {
  error?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await response.json()) as TokenResponse;
  if (!response.ok) {
    // invalid_grant means the stored refresh token is dead — expired, revoked,
    // or the account's password changed. Nothing retries its way out of that.
    if (json.error === "invalid_grant") {
      throw new GoogleReauthRequiredError(json.error_description ?? "the saved permission expired");
    }
    throw new Error(`Google refused the token request: ${json.error_description ?? response.status}`);
  }
  return json;
}

/** Reads the email out of the id_token without verifying it — display only. */
function emailFromIdToken(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return undefined;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: string };
    return decoded.email;
  } catch {
    return undefined;
  }
}

export async function completeConnection(code: string) {
  const { clientId, clientSecret, redirectUri } = config();
  const tokens = await tokenRequest({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  if (!tokens.access_token) throw new Error("Google returned no access token.");
  if (!tokens.refresh_token) {
    throw new Error(
      "Google returned no refresh token, so access would expire within the hour. Remove the app at myaccount.google.com/permissions and connect again.",
    );
  }

  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
  const accountEmail = emailFromIdToken(tokens.id_token);

  const account = await prisma.oAuthAccount.upsert({
    where: { provider: "GOOGLE" },
    create: {
      provider: "GOOGLE",
      accountEmail,
      accessToken: encryptToken(tokens.access_token),
      refreshToken: encryptToken(tokens.refresh_token),
      expiresAt,
      scopes: DRIVE_SCOPES,
    },
    update: {
      accountEmail,
      accessToken: encryptToken(tokens.access_token),
      refreshToken: encryptToken(tokens.refresh_token),
      expiresAt,
      scopes: DRIVE_SCOPES,
      isActive: true,
    },
  });

  await recordAudit({
    action: "oauth.google_connected",
    entityType: "OAuthAccount",
    entityId: account.id,
    actorType: "ASHER",
    details: { accountEmail },
  });
  return account;
}

export async function getConnection() {
  return prisma.oAuthAccount.findFirst({
    where: { provider: "GOOGLE", isActive: true },
    select: { id: true, accountEmail: true, connectedAt: true, expiresAt: true, scopes: true },
  });
}

export async function disconnect(): Promise<boolean> {
  const { count } = await prisma.oAuthAccount.updateMany({
    where: { provider: "GOOGLE", isActive: true },
    data: { isActive: false },
  });
  if (count > 0) {
    await recordAudit({ action: "oauth.google_disconnected", entityType: "OAuthAccount", actorType: "ASHER" });
  }
  return count > 0;
}

/**
 * Returns a usable access token, refreshing it first if it is expired or about
 * to be. Google's access tokens last about an hour, so anything long-lived has
 * to go through here rather than caching one.
 */
export async function getAccessToken(): Promise<string> {
  const account = await prisma.oAuthAccount.findFirst({ where: { provider: "GOOGLE", isActive: true } });
  if (!account) throw new GoogleNotConnectedError();

  const stillValid = account.expiresAt && account.expiresAt.getTime() - EXPIRY_MARGIN_MS > Date.now();
  if (stillValid) return decryptToken(account.accessToken);

  if (!account.refreshToken) throw new GoogleNotConnectedError();
  const { clientId, clientSecret } = config();

  const tokens = await tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: decryptToken(account.refreshToken),
    grant_type: "refresh_token",
  });
  if (!tokens.access_token) throw new Error("Google returned no access token when refreshing.");

  await prisma.oAuthAccount.update({
    where: { id: account.id },
    data: {
      accessToken: encryptToken(tokens.access_token),
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
    },
  });
  logger.info("oauth.google_token_refreshed");
  return tokens.access_token;
}
