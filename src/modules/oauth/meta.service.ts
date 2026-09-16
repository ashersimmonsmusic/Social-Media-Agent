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

/**
 * What the login asks Meta for.
 *
 * Meta rejects the whole login with "Invalid Scopes" if it is asked for a
 * permission the app has not been configured with — and which names an app
 * offers depends on when it was created and which use case it was set up under.
 * `instagram_basic`/`instagram_content_publish` belong to the older Instagram
 * API with Facebook Login; `instagram_business_basic`/
 * `instagram_business_content_publish` to the newer Instagram Login path. An app
 * accepts one pair, not both, and the error names only what it refused.
 *
 * So this is overridable from Railway. Finding the right set otherwise means a
 * deploy per guess, and the app's own Permissions screen is the only place the
 * answer is actually written down.
 */
const DEFAULT_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
];

export function scopes(): string[] {
  const configured = env.META_OAUTH_SCOPES;
  if (!configured) return DEFAULT_SCOPES;
  return configured
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

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
  url.searchParams.set("scope", scopes().join(","));
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
    if (pages.length === 0) {
      throw new MetaConnectError(
        "That login granted access to no Pages at all. Run /connect again and make sure the Page your Instagram " +
          "account sits behind is ticked — and that you picked the business portfolio it belongs to.",
      );
    }

    // Naming them is the whole diagnosis: if the right Page isn't in this list
    // it was never granted, and if it is, the Instagram link is what's missing.
    // Without the names both look identical from here.
    const names = pages.map((page) => `• ${page.name ?? page.id}`).join("\n");
    throw new MetaConnectError(
      `I got access to ${pages.length} Page(s), but none has an Instagram professional account attached:\n\n` +
        `${names}\n\n` +
        `If the Page you post from ISN'T in that list, run /connect again and tick it when Meta asks which Pages ` +
        `to allow.\n\n` +
        `If it IS in the list, then Instagram isn't linked to it. In Meta Business Suite go to Settings → ` +
        `Accounts → Instagram accounts, and connect your account to that Page.`,
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
