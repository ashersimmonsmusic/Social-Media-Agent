import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const envState: Record<string, unknown> = {
  DRY_RUN: true,
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  NEWSLETTER_UNSUBSCRIBE_SECRET: "s".repeat(64),
  WEBSITE_URL: "https://www.ashersimmonsmusic.com",
  RESEND_API_KEY: "re_test",
  RESEND_FROM_EMAIL: "Asher <hello@ashersimmonsmusic.com>",
};
let subscribers: string[] = [];
const audits: { action: string }[] = [];

vi.mock("../src/config/env.js", () => ({ env: envState }));
vi.mock("../src/modules/audit/audit.service.js", () => ({
  recordAudit: async (entry: { action: string }) => {
    audits.push(entry);
  },
}));
vi.mock("../src/modules/analytics/supabase.client.js", () => ({
  isSupabaseConfigured: () => Boolean(envState.SUPABASE_URL && envState.SUPABASE_SERVICE_ROLE_KEY),
  selectRows: async (_table: string, params: Record<string, string>) => {
    const offset = Number(params.offset ?? 0);
    const page = subscribers.slice(offset, offset + 1000).map((email) => ({ email }));
    return { rows: page, total: subscribers.length };
  },
}));

const { sendNewsletter, getRecipients, NewsletterNotConfiguredError, NewsletterSendError } = await import(
  "../src/modules/email/newsletter.service.js"
);

describe("getRecipients", () => {
  beforeEach(() => {
    subscribers = ["a@example.com", "b@example.com"];
    audits.length = 0;
    vi.restoreAllMocks();
  });

  it("returns everyone still subscribed", async () => {
    expect(await getRecipients()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("pages, so a long list isn't silently truncated", async () => {
    subscribers = Array.from({ length: 2500 }, (_, i) => `fan${i}@example.com`);
    expect(await getRecipients()).toHaveLength(2500);
  });
});

describe("sendNewsletter", () => {
  beforeEach(() => {
    subscribers = ["a@example.com", "b@example.com"];
    envState.DRY_RUN = true;
    envState.NEWSLETTER_UNSUBSCRIBE_SECRET = "s".repeat(64);
    audits.length = 0;
    vi.restoreAllMocks();
  });

  it("sends nothing under DRY_RUN but reports the reach", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await sendNewsletter({ subject: "Hello", body: "Out now." });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: 2, failed: 0, dryRun: true });
    expect(audits.map((a) => a.action)).toContain("newsletter.send_dry_run");
  });

  it("refuses to send with no unsubscribe secret, rather than mailing without a link", async () => {
    envState.NEWSLETTER_UNSUBSCRIBE_SECRET = undefined;
    await expect(sendNewsletter({ subject: "s", body: "b" })).rejects.toThrow(NewsletterNotConfiguredError);
  });

  it("refuses when nobody is subscribed", async () => {
    subscribers = [];
    await expect(sendNewsletter({ subject: "s", body: "b" })).rejects.toThrow(NewsletterSendError);
  });

  it("gives each recipient their own message and their own unsubscribe link", async () => {
    envState.DRY_RUN = false;
    let captured: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      captured = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>[];
      return new Response("{}", { status: 200 });
    });

    await sendNewsletter({ subject: "Hello", body: "Out now." });

    expect(captured).toHaveLength(2);
    expect(captured[0]!.to).toEqual(["a@example.com"]);
    // Nobody should be able to see anyone else's address.
    expect(captured[1]!.to).toEqual(["b@example.com"]);

    const expected = createHmac("sha256", "s".repeat(64)).update("a@example.com").digest("hex");
    expect(String(captured[0]!.html)).toContain(expected);
  });

  it("sets the one-click unsubscribe headers Gmail and Yahoo require", async () => {
    envState.DRY_RUN = false;
    let captured: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      captured = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>[];
      return new Response("{}", { status: 200 });
    });

    await sendNewsletter({ subject: "Hello", body: "Out now." });
    const headers = captured[0]!.headers as Record<string, string>;
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(headers["List-Unsubscribe"]).toContain("/api/unsubscribe?");
  });

  it("escapes the body so a stray angle bracket can't inject markup", async () => {
    envState.DRY_RUN = false;
    let captured: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      captured = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>[];
      return new Response("{}", { status: 200 });
    });

    await sendNewsletter({ subject: "s", body: "<script>alert(1)</script>" });
    expect(String(captured[0]!.html)).not.toContain("<script>");
    expect(String(captured[0]!.html)).toContain("&lt;script&gt;");
  });

  it("reports a total failure rather than claiming delivery", async () => {
    envState.DRY_RUN = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 422 }));
    await expect(sendNewsletter({ subject: "s", body: "b" })).rejects.toThrow(/nothing was delivered/i);
  });
});
