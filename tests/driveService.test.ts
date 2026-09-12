import { beforeEach, describe, expect, it, vi } from "vitest";

const envState: Record<string, unknown> = { GOOGLE_DRIVE_FOLDER_ID: undefined };
vi.mock("../src/config/env.js", () => ({ env: envState }));
vi.mock("../src/modules/oauth/google.service.js", () => ({ getAccessToken: async () => "token" }));

const { listVideos, downloadVideo, formatVideoList, formatDuration, DriveError } = await import(
  "../src/modules/drive/drive.service.js"
);

const file = {
  id: "f1",
  name: "studio.mp4",
  mimeType: "video/mp4",
  size: "52428800",
  createdTime: "2026-09-01T10:00:00Z",
  videoMediaMetadata: { durationMillis: "95000", width: 1920, height: 1080 },
};

// A fresh Response per call: a Response body can only be read once, and the
// real code gets a new one from each request.
function mockFetch(body: unknown, status = 200) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

describe("listVideos", () => {
  beforeEach(() => {
    envState.GOOGLE_DRIVE_FOLDER_ID = undefined;
    vi.restoreAllMocks();
  });

  it("asks only for videos, and skips the bin", async () => {
    const spy = mockFetch({ files: [file] });
    await listVideos();
    const query = new URL(String(spy.mock.calls[0]![0])).searchParams.get("q")!;
    expect(query).toContain("mimeType contains 'video/'");
    expect(query).toContain("trashed = false");
  });

  it("narrows to one folder when configured, so it can't roam the whole Drive", async () => {
    envState.GOOGLE_DRIVE_FOLDER_ID = "folder123";
    const spy = mockFetch({ files: [] });
    await listVideos();
    expect(new URL(String(spy.mock.calls[0]![0])).searchParams.get("q")).toContain("'folder123' in parents");
  });

  it("includes shared drives, which are invisible without it", async () => {
    const spy = mockFetch({ files: [] });
    await listVideos();
    const params = new URL(String(spy.mock.calls[0]![0])).searchParams;
    expect(params.get("includeItemsFromAllDrives")).toBe("true");
    expect(params.get("supportsAllDrives")).toBe("true");
  });

  it("parses length and dimensions", async () => {
    mockFetch({ files: [file] });
    const [video] = await listVideos();
    expect(video!.durationMillis).toBe(95000);
    expect(video!.width).toBe(1920);
    expect(video!.sizeBytes).toBe(52428800);
  });

  it("returns an empty list rather than throwing when Drive has none", async () => {
    mockFetch({});
    expect(await listVideos()).toEqual([]);
  });

  it("surfaces a refusal with its reason", async () => {
    mockFetch({ error: "nope" }, 403);
    await expect(listVideos()).rejects.toThrow(/403/);
  });
});

describe("downloadVideo", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("refuses a file over the cap instead of exhausting memory", async () => {
    mockFetch(file);
    await expect(downloadVideo("f1", 10 * 1024 * 1024)).rejects.toThrow(DriveError);
    await expect(downloadVideo("f1", 10 * 1024 * 1024)).rejects.toThrow(/50MB.*10MB/);
  });
});

describe("formatting", () => {
  it("renders length as minutes and seconds", () => {
    expect(formatDuration(95000)).toBe("1:35");
    expect(formatDuration(undefined)).toBe("unknown length");
  });

  it("says plainly when there's nothing there", () => {
    expect(formatVideoList([])).toMatch(/no videos/i);
  });
});
