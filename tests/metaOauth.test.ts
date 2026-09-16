import { beforeEach, describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = {};
const connected: Record<string, unknown>[] = [];

vi.mock("../src/config/env.js", () => ({ env: envState }));
vi.mock("../src/modules/social/social.service.js", () => ({
  connectAccount: async (input: Record<string, unknown>) => {
    connected.push(input);
    return input;
  },
}));

const { authorisationUrl, completeConnection, verifyMetaState, MetaNotConfiguredError, MetaConnectError } =
  await import("../src/modules/oauth/meta.service.js");
const { createState } = await import("../src/modules/oauth/state.js");

/** Replays the three Graph calls the flow makes, in order. */
function scriptGraph(responses: unknown[], status = 200) {
  const urls: string[] = [];
  let index = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    urls.push(String(input));
    const body = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(body), { status });
  });
  return urls;
}

const pageWithInstagram = {
  data: [
    {
      id: "166123847142279",
      name: "Asher Simmons Music",
      access_token: "page-token-that-does-not-expire",
      instagram_business_account: { id: "17841401850490652", username: "ashersimmonsmusic" },
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  connected.length = 0;
  for (const key of Object.keys(envState)) delete envState[key];
  Object.assign(envState, {
    META_APP_ID: "app-123",
    META_APP_SECRET: "secret-456",
    META_GRAPH_API_VERSION: "v21.0",
    PUBLIC_BASE_URL: "https://app.up.railway.app",
    SOCIAL_TOKEN_KEY: "k".repeat(64),
  });
});

describe("authorisationUrl", () => {
  it("asks for publishing permission and sends Meta back to our callback", () => {
    const url = new URL(authorisationUrl());
    expect(url.searchParams.get("scope")).toContain("instagram_content_publish");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.up.railway.app/oauth/meta/callback");
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("can be pointed at whatever permissions the app actually offers", () => {
    // Which names are valid depends on how the app was set up, and getting it
    // wrong fails the login before any consent screen. Changing it must not
    // need a deploy.
    envState.META_OAUTH_SCOPES = "instagram_business_basic, instagram_business_content_publish ,pages_show_list";
    const asked = (new URL(authorisationUrl()).searchParams.get("scope") ?? "").split(",");
    expect(asked).toEqual(["instagram_business_basic", "instagram_business_content_publish", "pages_show_list"]);
  });

  it("falls back to the Facebook Login set when nothing is configured", () => {
    const asked = (new URL(authorisationUrl()).searchParams.get("scope") ?? "").split(",");
    expect(asked).toContain("instagram_content_publish");
    expect(asked).toContain("pages_show_list");
  });

  it("names what is missing rather than failing vaguely", () => {
    envState.META_APP_SECRET = undefined;
    expect(() => authorisationUrl()).toThrow(MetaNotConfiguredError);
    expect(() => authorisationUrl()).toThrow(/META_APP_SECRET/);
  });

  it("does not accept a state minted for a different provider", () => {
    // Namespacing stops a Google state being replayed against this callback.
    expect(verifyMetaState(createState("google-oauth"))).toBe(false);
    expect(verifyMetaState(createState("meta-oauth"))).toBe(true);
  });
});

describe("completeConnection", () => {
  it("exchanges for a long-lived token before reading the Page token", async () => {
    const urls = scriptGraph([
      { access_token: "short-lived" },
      { access_token: "long-lived" },
      pageWithInstagram,
    ]);

    await completeConnection("auth-code");

    // Without this exchange the stored Page token would expire within the hour.
    expect(urls[1]).toContain("grant_type=fb_exchange_token");
    expect(urls[1]).toContain("fb_exchange_token=short-lived");
    expect(urls[2]).toContain("access_token=long-lived");
  });

  it("stores the Instagram account and its Page token, with no expiry", async () => {
    scriptGraph([{ access_token: "short" }, { access_token: "long" }, pageWithInstagram]);

    const result = await completeConnection("auth-code");

    expect(result).toEqual({ username: "ashersimmonsmusic", instagramAccountId: "17841401850490652" });
    expect(connected).toHaveLength(1);
    expect(connected[0]).toMatchObject({
      platform: "INSTAGRAM",
      platformAccountId: "17841401850490652",
      accessToken: "page-token-that-does-not-expire",
    });
    // A false expiry would have the bot warn about one that never arrives.
    expect(connected[0]!.tokenExpiresAt).toBeUndefined();
  });

  it("explains the empty case rather than storing nothing silently", async () => {
    scriptGraph([{ access_token: "short" }, { access_token: "long" }, { data: [] }]);

    await expect(completeConnection("code")).rejects.toThrow(/business portfolio/);
    expect(connected).toHaveLength(0);
  });

  it("says what to fix when a Page has no Instagram account attached", async () => {
    scriptGraph([
      { access_token: "short" },
      { access_token: "long" },
      { data: [{ id: "p1", name: "Some Page", access_token: "t" }] },
    ]);

    await expect(completeConnection("code")).rejects.toThrow(/Meta Business Suite/);
  });

  it("passes Meta's own refusal through instead of a generic failure", async () => {
    scriptGraph([{ error: { message: "This authorization code has been used." } }], 400);

    await expect(completeConnection("stale-code")).rejects.toThrow(MetaConnectError);
    await expect(completeConnection("stale-code")).rejects.toThrow(/has been used/);
  });

  it("picks the Page that actually has Instagram behind it", async () => {
    scriptGraph([
      { access_token: "short" },
      { access_token: "long" },
      {
        data: [
          { id: "p1", name: "Old Page", access_token: "t1" },
          {
            id: "p2",
            name: "Asher Simmons Music",
            access_token: "t2",
            instagram_business_account: { id: "17841401850490652", username: "ashersimmonsmusic" },
          },
        ],
      },
    ]);

    await completeConnection("code");
    expect(connected[0]).toMatchObject({ accessToken: "t2" });
  });
});
