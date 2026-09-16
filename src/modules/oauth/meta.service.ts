import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { connectAccount } from "../social/social.service.js";
import { createState, verifyState } from "./state.js";

/**
 * Connecting Instagram without anyone handling a token.
 *
 * The alternative is the Graph API Explorer: generate a user token, exchange it
 * for a long-lived one, call me/accounts, and copy a Page token out of the
 * response — four steps involving the app secret and a reply that contains a
 * publishing credential for every Page on the account. Asher pasted one of those
 * into a chat twice. This removes the opportunity.
 *
 * It also fixes the expiry properly. A token straight from the Explorer lasts an
 * hour; the Page token reached through a long-lived user token does not expire
 * at all, and that is the one stored here.
 */

const STATE_NAMESPACE = "meta-oauth";

/** Publishing needs the first two; the Page lookup needs the rest. */
const SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
];

export class MetaNotConfiguredError extends Error {
  constructor(missing: string[]) {
    const list = missing.length === 1 ? missing[0]! : `${missing.slice(0, -1).join(", ")} and ${missing.at(-1)!}`;
    super(
      `Instagram isn't set up yet — ${list} ${missing.length === 1 ? "needs" : "need"} setting in Railway. ` +
        `SOCIAL_SETUP.md says where ${missing.length === 1 ? "it comes" : "they come"} from.`,
    );
    this.name = "MetaNotConfiguredError";
  }
}

export class MetaConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaConnectError";
  }
}

function config() {
  const appId = env.META_APP_ID;
  const appSecret = env.META_APP_SECRET;
  const base = env.PUBLIC_BASE_URL;

  const missing = [
    !appId && "META_APP_ID",
    !appSecret && "META_APP_SECRET",
    !base && "PUBLIC_BASE_URL",
  ].filter((name): name is string => typeof name === "string");
  if (missing.length > 0) throw new MetaNotConfiguredError(missing);

  return { appId: appId!, appSecret: appSecret!, redirectUri: `${base!.replace(/\/$/, "")}/oauth/meta/callback` };
}

export function authorisationUrl(): string {
  const { appId, redirectUri } = config();
  const url = new URL(`https://www.facebook.com/${env.META_GRAPH_API_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(","));
  url.searchParams.set("state", createState(STATE_NAMESPACE));
  return url.toString();
}

export function verifyMetaState(state: string): boolean {
  return verifyState(STATE_NAMESPACE, state);
}

async function graphGet(path: string, params: Record<string, string>, what: string): Promise<Record<string, unknown>> {
  const url = new URL(`https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new MetaConnectError(`Couldn't reach Meta to ${what}: ${error instanceof Error ? error.message : error}`);
  }

  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = json.error as { message?: string } | undefined;
    throw new MetaConnectError(`Meta refused to ${what}: ${error?.message ?? `HTTP ${response.status}`}`);
  }
  return json;
}

interface PageEntry {
  id: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: { id: string; username?: string };
}

/**
 * Finishes the round trip: code to short-lived token, to long-lived token, to a
 * Page token that doesn't expire, to the Instagram account behind it.
 */
export async function completeConnection(code: string): Promise<{ username?: string; instagramAccountId: string }> {
  const { appId, appSecret, redirectUri } = config();

  const shortLived = await graphGet(
    "oauth/access_token",
    { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
    "swap the login for a token",
  );
  const userToken = typeof shortLived.access_token === "string" ? shortLived.access_token : "";
  if (!userToken) throw new MetaConnectError("Meta returned no token for that login.");

  // Without this exchange the Page token below expires in about an hour.
  const longLived = await graphGet(
    "oauth/access_token",
    { grant_type: "fb_exchange_token", client_id: appId, client_secret: appSecret, fb_exchange_token: userToken },
    "make the token long-lived",
  );
  const longLivedToken = typeof longLived.access_token === "string" ? longLived.access_token : userToken;

  const accounts = await graphGet(
    "me/accounts",
    { fields: "id,name,access_token,instagram_business_account{id,username}", access_token: longLivedToken },
    "find your Page",
  );

  const pages = (accounts.data as PageEntry[] | undefined) ?? [];
  const withInstagram = pages.find((page) => page.instagram_business_account?.id);

  if (!withInstagram) {
    throw new MetaConnectError(
      pages.length === 0
        ? "That account manages no Pages, so there's no Instagram account behind one. Check you approved the right " +
          "business portfolio when Meta asked."
        : `Found ${pages.length} Page(s), but none with an Instagram professional account attached. ` +
          `Link your Instagram account to your Page in Meta Business Suite, then try again.`,
    );
  }

  const instagram = withInstagram.instagram_business_account!;
  const pageToken = withInstagram.access_token;
  if (!pageToken) {
    throw new MetaConnectError("Meta returned the Page but no token for it. Try connecting again.");
  }

  await connectAccount({
    platform: "INSTAGRAM",
    platformAccountId: instagram.id,
    username: instagram.username,
    // Deliberately no expiry: a Page token reached through a long-lived user
    // token doesn't have one, and recording a false date would make the bot
    // warn about an expiry that never comes.
    accessToken: pageToken,
  });

  logger.info("oauth.meta_connected", { instagramAccountId: instagram.id });
  return { username: instagram.username, instagramAccountId: instagram.id };
}
