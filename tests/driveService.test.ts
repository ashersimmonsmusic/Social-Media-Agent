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

describe("listVideos inside a folder tree", () => {
  /**
   * Replays Drive's responses in call order and records each query, so the
   * walk can be asserted without a network.
   */
  function scriptDrive(responses: unknown[]) {
    const queries: string[] = [];
    let index = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      queries.push(new URL(String(input)).searchParams.get("q") ?? "");
      const body = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return queries;
  }

  const video = (id: string, created: string) => ({
    id,
    name: `${id}.mp4`,
    mimeType: "video/mp4",
    size: "1048576",
    createdTime: created,
    videoMediaMetadata: { durationMillis: "5000", width: 1920, height: 1080 },
  });

  beforeEach(() => {
    envState.GOOGLE_DRIVE_FOLDER_ID = "root-folder";
    vi.restoreAllMocks();
  });

  it("finds videos nested in subfolders, not just loose ones", async () => {
    const queries = scriptDrive([
      { files: [{ id: "sub-a" }] }, // depth 1 under root
      { files: [] }, //               depth 2 under sub-a
      { files: [video("deep", "2026-09-10T10:00:00Z")] },
    ]);

    const videos = await listVideos(10);

    expect(videos.map((v) => v.id)).toEqual(["deep"]);
    // Both folders are asked about together, in one query.
    expect(queries.at(-1)).toContain("'root-folder' in parents");
    expect(queries.at(-1)).toContain("'sub-a' in parents");
  });

  it("returns newest first across separate folders", async () => {
    const queries = scriptDrive([
      { files: [] },
      { files: [video("old", "2026-01-01T00:00:00Z"), video("new", "2026-09-01T00:00:00Z")] },
    ]);

    const videos = await listVideos(10);

    expect(videos.map((v) => v.id)).toEqual(["new", "old"]);
    expect(queries).toHaveLength(2);
  });

  it("lists a file once even when it sits in two folders", async () => {
    scriptDrive([
      { files: [] },
      { files: [video("dup", "2026-05-05T00:00:00Z"), video("dup", "2026-05-05T00:00:00Z")] },
    ]);

    expect(await listVideos(10)).toHaveLength(1);
  });

  it("honours the limit after merging folders", async () => {
    scriptDrive([
      { files: [] },
      {
        files: [
          video("a", "2026-09-03T00:00:00Z"),
          video("b", "2026-09-02T00:00:00Z"),
          video("c", "2026-09-01T00:00:00Z"),
        ],
      },
    ]);

    expect((await listVideos(2)).map((v) => v.id)).toEqual(["a", "b"]);
  });

  it("stops rather than looping when a folder is its own ancestor", async () => {
    // Drive allows a folder in two places; a naive walk would never finish.
    scriptDrive([{ files: [{ id: "root-folder" }] }, { files: [] }]);

    await expect(listVideos(10)).resolves.toBeDefined();
  });

  it("does not walk a tree at all when no folder is configured", async () => {
    envState.GOOGLE_DRIVE_FOLDER_ID = undefined;
    const queries = scriptDrive([{ files: [video("any", "2026-09-01T00:00:00Z")] }]);

    await listVideos(10);

    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain("in parents");
  });
});
