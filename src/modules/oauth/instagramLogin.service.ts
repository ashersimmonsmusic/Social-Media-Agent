import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { connectAccount } from "../social/social.service.js";
import { createState, verifyState } from "./state.js";

/**
 * Connecting Instagram directly, without a Facebook Page in the way.
 *
 * The Facebook Login path reaches Instagram through a chain — user, to a role
 * on a Page, to that Page's link to the account, all inside the right business
 * portfolio — and a break anywhere returns an empty list naming nothing. Asher's
 * chain is broken somewhere invisible: the Page is linked, he can see it and
 * tick it on the consent screen, and it still comes back empty.
 *
 * This path has no chain. He logs in as the Instagram account and that is the
 * account. It is Meta's own replacement for the Page route, and it exists
 * because the Page route does this to people.
 */

const STATE_NAMESPACE = "instagram-login";

const AUTH_ENDPOINT = "https://www.instagram.com/oauth/authorize";
const TOKEN_ENDPOINT = "https://api.instagram.com/oauth/access_token";
export const GRAPH_HOST = "https://graph.instagram.com";

/** The names this API uses. Different strings from the Facebook Login path. */
const SCOPES = ["instagram_business_basic", "instagram_business_content_publish"];

/** Long-lived tokens last 60 days and are renewed without anyone present. */
const LONG_LIVED_DAYS = 60;

export class InstagramNotConfiguredError extends Error {
  constructor(missing: string[]) {
    const list = missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)!}`;
    super(
      `Instagram Login isn't set up yet — ${list} ${missing.length === 1 ? "needs" : "need"} setting in Railway. ` +
        `SOCIAL_SETUP.md says where ${missing.length === 1 ? "it comes" : "they come"} from.`,
    );
    this.name = "InstagramNotConfiguredError";
  }
}

export class InstagramConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstagramConnectError";
  }
}

function config() {
  // Deliberately NOT the Facebook app id and secret. The Instagram product has
  // its own pair, on its own settings page, and the two look identical.
  const clientId = env.INSTAGRAM_APP_ID;
  const clientSecret = env.INSTAGRAM_APP_SECRET;
  const base = env.PUBLIC_BASE_URL;

  const missing = [
    !clientId && "INSTAGRAM_APP_ID",
    !clientSecret && "INSTAGRAM_APP_SECRET",
    !base && "PUBLIC_BASE_URL",
  ].filter((name): name is string => typeof name === "string");
  if (missing.length > 0) throw new InstagramNotConfiguredError(missing);

  return { clientId: clientId!, clientSecret: clientSecret!, redirectUri: `${base!.replace(/\/$/, "")}/oauth/instagram/callback` };
}

export function authorisationUrl(): string {
  const { clientId, redirectUri } = config();
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", createState(STATE_NAMESPACE));
  return url.toString();
}

export function verifyInstagramState(state: string): boolean {
  return verifyState(STATE_NAMESPACE, state);
}

async function readJson(response: Response, what: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // reported via status below
  }
  if (!response.ok) {
    const error = json.error_message ?? (json.error as { message?: string } | undefined)?.message;
    throw new InstagramConnectError(`Instagram refused to ${what}: ${error ?? text.slice(0, 200)}`);
  }
  return json;
}

/**
 * Swaps the code for a token that lasts an hour, then for one that lasts sixty
 * days. Only the second is worth storing.
 */
export async function completeConnection(code: string): Promise<{ username?: string; instagramAccountId: string }> {
  const { clientId, clientSecret, redirectUri } = config();

  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      }),
    });
  } catch (error) {
    throw new InstagramConnectError(`Couldn't reach Instagram: ${error instanceof Error ? error.message : error}`);
  }

  const shortLived = await readJson(response, "swap the login for a token");
  const shortToken = typeof shortLived.access_token === "string" ? shortLived.access_token : "";
  const userId = shortLived.user_id !== undefined ? String(shortLived.user_id) : "";
  if (!shortToken || !userId) throw new InstagramConnectError("Instagram returned no token for that login.");

  const exchangeUrl = new URL(`${GRAPH_HOST}/access_token`);
  exchangeUrl.searchParams.set("grant_type", "ig_exchange_token");
  exchangeUrl.searchParams.set("client_secret", clientSecret);
  exchangeUrl.searchParams.set("access_token", shortToken);
  const longLived = await readJson(await fetch(exchangeUrl), "make the token long-lived");
  const longToken = typeof longLived.access_token === "string" ? longLived.access_token : shortToken;
  const expiresInSeconds = typeof longLived.expires_in === "number" ? longLived.expires_in : LONG_LIVED_DAYS * 86400;

  // The username is cosmetic — a failure here must not lose a working token.
  let username: string | undefined;
  try {
    const profileUrl = new URL(`${GRAPH_HOST}/me`);
    profileUrl.searchParams.set("fields", "user_id,username");
    profileUrl.searchParams.set("access_token", longToken);
    const profile = await readJson(await fetch(profileUrl), "read your username");
    username = typeof profile.username === "string" ? profile.username : undefined;
  } catch (error) {
    logger.warn("oauth.instagram_username_failed", { error: String(error) });
  }

  await connectAccount({
    platform: "INSTAGRAM",
    platformAccountId: userId,
    username,
    accessToken: longToken,
    tokenExpiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    authType: "INSTAGRAM_LOGIN",
  });

  logger.info("oauth.instagram_connected", { instagramAccountId: userId });
  return { username, instagramAccountId: userId };
}

/**
 * Renews a long-lived token. Needs no one present, which is the point: the
 * sixty-day expiry never becomes Asher's problem as long as the bot runs.
 */
export async function refreshLongLivedToken(currentToken: string): Promise<{ token: string; expiresAt: Date }> {
  const url = new URL(`${GRAPH_HOST}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", currentToken);

  const json = await readJson(await fetch(url), "renew the token");
  const token = typeof json.access_token === "string" ? json.access_token : "";
  if (!token) throw new InstagramConnectError("Instagram returned no token when renewing.");

  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : LONG_LIVED_DAYS * 86400;
  return { token, expiresAt: new Date(Date.now() + expiresIn * 1000) };
}
