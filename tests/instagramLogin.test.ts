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

const { authorisationUrl, completeConnection, refreshLongLivedToken, verifyInstagramState, InstagramNotConfiguredError } =
  await import("../src/modules/oauth/instagramLogin.service.js");
const { createState } = await import("../src/modules/oauth/state.js");

function scriptCalls(responses: unknown[], status = 200) {
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

beforeEach(() => {
  vi.restoreAllMocks();
  connected.length = 0;
  for (const key of Object.keys(envState)) delete envState[key];
  Object.assign(envState, {
    INSTAGRAM_APP_ID: "ig-app-1",
    INSTAGRAM_APP_SECRET: "ig-secret",
    PUBLIC_BASE_URL: "https://app.up.railway.app",
    SOCIAL_TOKEN_KEY: "k".repeat(64),
  });
});

describe("authorisationUrl", () => {
  it("sends him to Instagram, not Facebook", () => {
    // The whole point: no Page, no portfolio, no role in between.
    const url = new URL(authorisationUrl());
    expect(url.host).toBe("www.instagram.com");
    expect(url.pathname).toBe("/oauth/authorize");
  });

  it("asks for the Instagram Login permission names", () => {
    const scope = new URL(authorisationUrl()).searchParams.get("scope") ?? "";
    expect(scope).toContain("instagram_business_content_publish");
    expect(scope).not.toContain("pages_show_list");
  });

  it("names which credentials are missing", () => {
    envState.INSTAGRAM_APP_SECRET = undefined;
    expect(() => authorisationUrl()).toThrow(InstagramNotConfiguredError);
    expect(() => authorisationUrl()).toThrow(/INSTAGRAM_APP_SECRET/);
  });

  it("will not accept a state minted for the Facebook flow", () => {
    expect(verifyInstagramState(createState("meta-oauth"))).toBe(false);
    expect(verifyInstagramState(createState("instagram-login"))).toBe(true);
  });
});

describe("completeConnection", () => {
  it("stores a long-lived token against the Instagram Login path", async () => {
    const urls = scriptCalls([
      { access_token: "short", user_id: 17841401850490652 },
      { access_token: "long", expires_in: 5_184_000 },
      { username: "ashersimmonsmusic" },
    ]);

    const result = await completeConnection("code");

    expect(result.instagramAccountId).toBe("17841401850490652");
    expect(urls[1]).toContain("ig_exchange_token");
    expect(connected[0]).toMatchObject({
      platformAccountId: "17841401850490652",
      accessToken: "long",
      username: "ashersimmonsmusic",
      // Without this the adapter would send it to the wrong host.
      authType: "INSTAGRAM_LOGIN",
    });
  });

  it("keeps the token even if reading the username fails", async () => {
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ access_token: "short", user_id: "123" }), { status: 200 });
      if (call === 2) return new Response(JSON.stringify({ access_token: "long", expires_in: 100 }), { status: 200 });
      return new Response(JSON.stringify({ error_message: "nope" }), { status: 400 });
    });

    await completeConnection("code");

    // A cosmetic lookup must not throw away a working credential.
    expect(connected).toHaveLength(1);
    expect(connected[0]).toMatchObject({ accessToken: "long", username: undefined });
  });

  it("records when the token runs out, so it can be renewed in time", async () => {
    scriptCalls([
      { access_token: "short", user_id: "123" },
      { access_token: "long", expires_in: 5_184_000 },
      { username: "x" },
    ]);

    await completeConnection("code");

    const expiry = connected[0]!.tokenExpiresAt as Date;
    const daysAway = (expiry.getTime() - Date.now()) / 86_400_000;
    expect(daysAway).toBeGreaterThan(59);
    expect(daysAway).toBeLessThan(61);
  });

  it("passes Instagram's own refusal through", async () => {
    scriptCalls([{ error_message: "Invalid authorization code" }], 400);
    await expect(completeConnection("stale")).rejects.toThrow(/Invalid authorization code/);
    expect(connected).toHaveLength(0);
  });
});

describe("refreshLongLivedToken", () => {
  it("renews without anyone present", async () => {
    scriptCalls([{ access_token: "renewed", expires_in: 5_184_000 }]);

    const result = await refreshLongLivedToken("old-token");

    expect(result.token).toBe("renewed");
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("reports a refusal rather than returning an empty token", async () => {
    scriptCalls([{ error_message: "expired" }], 400);
    await expect(refreshLongLivedToken("dead")).rejects.toThrow(/expired/);
  });
});
