import { beforeEach, describe, expect, it, vi } from "vitest";

const state = {
  analysed: null as { filename: string; transcriptText: string | null } | null,
  reply: "Louisiana live set second half",
};
const prompts: { system: string; prompt: string }[] = [];

vi.mock("../src/config/env.js", () => ({ env: {} }));
vi.mock("../src/lib/logger.js", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock("../src/db/prisma.js", () => ({ prisma: { sourceVideo: { findUnique: async () => state.analysed } } }));
vi.mock("../src/ai/AIService.js", () => ({
  aiService: {
    generate: async (_task: string, prompt: string, options: { system?: string }) => {
      prompts.push({ system: options.system ?? "", prompt });
      return { text: state.reply };
    },
  },
}));
vi.mock("../src/modules/drive/drive.service.js", () => ({
  downloadToFile: async () => ({}),
  getVideo: async () => ({ name: "00066.MTS", sizeBytes: 1000 }),
}));
vi.mock("../src/modules/video/ffmpeg.js", () => ({
  assertRoomFor: async () => {},
  extractFrames: async () => [Buffer.from("x")],
  probe: async () => ({ durationSeconds: 600, width: 1920, height: 1080 }),
  withTempDir: async (work: (dir: string) => Promise<unknown>) => work("/tmp/x"),
}));

const { suggestFromTranscript, suggestName, looksUnnamed } = await import("../src/modules/drive/naming.service.js");

beforeEach(() => {
  prompts.length = 0;
  state.analysed = { filename: "00066.MTS", transcriptText: "So this is the second half of the Louisiana set." };
  state.reply = "Louisiana live set second half";
});

describe("looksUnnamed", () => {
  it("spots what a camera or phone produces", () => {
    expect(looksUnnamed("00066.MTS")).toBe(true);
    expect(looksUnnamed("1547174371597.mp4")).toBe(true);
    expect(looksUnnamed("IMG_4821.mov")).toBe(true);
    expect(looksUnnamed("DSC0012.mp4")).toBe(true);
  });

  it("leaves a name he chose alone", () => {
    expect(looksUnnamed("Louisiana live set.mp4")).toBe(false);
    expect(looksUnnamed("studio session 3.mov")).toBe(false);
  });
});

describe("suggestFromTranscript", () => {
  it("names it from what is said, which identifies a session better than frames", async () => {
    expect(await suggestFromTranscript("f1")).toBe("Louisiana live set second half");
    expect(prompts[0]!.prompt).toContain("Louisiana set");
  });

  it("asks for a label rather than a title", async () => {
    await suggestFromTranscript("f1");
    // The failure mode is a model writing something evocative and useless for
    // finding a file six months later.
    expect(prompts[0]!.system).toMatch(/label, not a title/i);
    expect(prompts[0]!.system).toMatch(/No marketing/i);
  });

  it("returns nothing when the video has not been read", async () => {
    state.analysed = null;
    expect(await suggestFromTranscript("f1")).toBeNull();
  });

  it("returns nothing rather than guessing when the model says UNKNOWN", async () => {
    state.reply = "UNKNOWN";
    expect(await suggestFromTranscript("f1")).toBeNull();
  });

  it("strips an extension the model added back on", async () => {
    state.reply = "Louisiana live set.mp4";
    expect(await suggestFromTranscript("f1")).toBe("Louisiana live set");
  });

  it("strips quotes and characters a filename cannot carry", async () => {
    state.reply = '"Louisiana: live/set"';
    expect(await suggestFromTranscript("f1")).toBe("Louisiana liveset");
  });
});

describe("suggestName", () => {
  it("prefers the transcript, which is free and better", async () => {
    const result = await suggestName("f1");
    expect(result).toEqual({ name: "Louisiana live set second half", basis: "transcript" });
    // One call: it never downloaded anything.
    expect(prompts).toHaveLength(1);
  });

  it("falls back to frames when nothing has read the video", async () => {
    state.analysed = null;
    const result = await suggestName("f1");
    expect(result!.basis).toBe("frames");
  });

  it("will not download when told not to", async () => {
    state.analysed = null;
    expect(await suggestName("f1", false)).toBeNull();
    expect(prompts).toHaveLength(0);
  });
});
