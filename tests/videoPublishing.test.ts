import { afterEach, describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = {
  DRY_RUN: false,
  META_GRAPH_API_VERSION: "v21.0",
  SOCIAL_TOKEN_KEY: "a".repeat(64),
  // The router pulls in the asset service, which builds a storage provider on import.
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_PATH: "./uploads",
};

vi.mock("../src/config/env.js", () => ({ env: envState }));
vi.mock("../src/modules/audit/audit.service.js", () => ({ recordAudit: async () => {} }));

const { InstagramAdapter, PublishError } = await import("../src/modules/social/instagram.adapter.js");
const { parseRange } = await import("../src/http/router.js");

const account = { platform: "INSTAGRAM" as const, platformAccountId: "178414000", accessToken: "secret" };
// Real delays are tens of seconds; the loop's behaviour is what's under test,
// not the waiting, so it's driven at millisecond speed here.
const adapter = new InstagramAdapter({ firstDelayMs: 1, maxDelayMs: 2, timeoutMs: 200 });
const videoPost = { caption: "live at the Louisiana", mediaUrl: "https://example.com/a.mp4", mediaKind: "VIDEO" as const };

interface Call {
  url: string;
  body?: string;
}

/**
 * Replays a scripted sequence of Graph responses and records what was sent.
 * A fresh Response per call, since a body can only be read once.
 */
function scriptFetch(responses: unknown[]): Call[] {
  const calls: Call[] = [];
  let index = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls.push({ url: String(input), body: init?.body ? String(init.body) : undefined });
    const payload = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(payload), { status: 200 });
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("publishing a video", () => {
  it("creates a REELS container with video_url, not image_url", async () => {
    const calls = scriptFetch([{ id: "container-1" }, { status_code: "FINISHED" }, { id: "post-1" }]);

    const result = await adapter.publish(account, videoPost);

    expect(result).toEqual({ platformPostId: "post-1", dryRun: false });
    const create = new URLSearchParams(calls[0]!.body);
    expect(create.get("media_type")).toBe("REELS");
    expect(create.get("video_url")).toBe("https://example.com/a.mp4");
    expect(create.get("image_url")).toBeNull();
  });

  it("waits for the container to report FINISHED before publishing", async () => {
    const calls = scriptFetch([
      { id: "container-1" },
      { status_code: "IN_PROGRESS" },
      { status_code: "FINISHED" },
      { id: "post-1" },
    ]);

    await adapter.publish(account, videoPost);

    // create, poll, poll, publish — the second poll is what released it.
    expect(calls).toHaveLength(4);
    expect(calls[1]!.url).toContain("status_code");
    expect(calls[3]!.url).toContain("media_publish");
  });

  it("does not poll at all for an image, which is ready immediately", async () => {
    const calls = scriptFetch([{ id: "container-1" }, { id: "post-1" }]);

    await adapter.publish(account, { caption: "a photo", mediaUrl: "https://example.com/a.jpg", mediaKind: "IMAGE" });

    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.url.includes("status_code"))).toBe(false);
  });

  it("gives a reason naming the format rules when Instagram rejects the video", async () => {
    scriptFetch([{ id: "container-1" }, { status_code: "ERROR", status: "Unsupported format" }]);

    // One attempt only: the scripted responses are consumed in order.
    const error = await adapter.publish(account, videoPost).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(PublishError);
    expect((error as Error).message).toMatch(/H\.264/);
    expect((error as Error).message).toMatch(/Unsupported format/);
  });

  it("never publishes a container that expired", async () => {
    const calls = scriptFetch([{ id: "container-1" }, { status_code: "EXPIRED" }]);

    await expect(adapter.publish(account, videoPost)).rejects.toThrow(/expired/i);
    expect(calls.some((call) => call.url.includes("media_publish"))).toBe(false);
  });

  it("gives up rather than waiting forever on a container that never finishes", async () => {
    const calls = scriptFetch([{ id: "container-1" }, { status_code: "IN_PROGRESS" }]);

    await expect(adapter.publish(account, videoPost)).rejects.toThrow(/stopped waiting/i);
    expect(calls.some((call) => call.url.includes("media_publish"))).toBe(false);
  });

  it("still publishes nothing under DRY_RUN", async () => {
    envState.DRY_RUN = true;
    const calls = scriptFetch([{ id: "never" }]);
    try {
      const result = await adapter.publish(account, videoPost);
      expect(result.dryRun).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      envState.DRY_RUN = false;
    }
  });
});

describe("parseRange", () => {
  it("reads a normal range", () => {
    expect(parseRange("bytes=0-499", 1000)).toEqual({ start: 0, end: 499 });
  });

  it("treats an open-ended range as running to the last byte", () => {
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
  });

  it("reads a suffix range as the final bytes, not the first", () => {
    expect(parseRange("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
  });

  it("clamps a range that runs past the end", () => {
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("ignores anything it can't use rather than serving the wrong bytes", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange("bytes=", 1000)).toBeNull();
    expect(parseRange("items=0-10", 1000)).toBeNull();
    expect(parseRange("bytes=0-10, 20-30", 1000)).toBeNull();
    expect(parseRange("bytes=900-100", 1000)).toBeNull();
  });
});
