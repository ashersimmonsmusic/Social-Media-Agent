import { describe, expect, it, vi } from "vitest";

const generateCalls: { prompt: string; options: Record<string, unknown> }[] = [];

vi.mock("../src/ai/AIService.js", () => ({
  aiService: {
    generate: async (_task: string, prompt: string, options: Record<string, unknown>) => {
      generateCalls.push({ prompt, options });
      return { text: '{"summary":"a poster","facts":[]}' };
    },
  },
}));

const { analyseAttachment, canAnalyse, AttachmentTooLargeError, UnsupportedAttachmentError } = await import(
  "../src/modules/knowledge/attachment.service.js"
);

describe("canAnalyse", () => {
  it("accepts PDFs and the supported image types", () => {
    expect(canAnalyse("application/pdf")).toBe(true);
    expect(canAnalyse("image/jpeg")).toBe(true);
    expect(canAnalyse("image/png")).toBe(true);
    expect(canAnalyse("image/webp")).toBe(true);
  });

  it("rejects what the API can't read, so uploads aren't charged for nothing", () => {
    expect(canAnalyse("video/mp4")).toBe(false);
    expect(canAnalyse("audio/mpeg")).toBe(false);
    expect(canAnalyse("application/msword")).toBe(false);
    expect(canAnalyse(undefined)).toBe(false);
  });
});

describe("analyseAttachment", () => {
  it("refuses a file too large to send, naming the size", async () => {
    await expect(
      analyseAttachment({
        mediaType: "application/pdf",
        data: Buffer.alloc(13 * 1024 * 1024),
        filename: "huge.pdf",
      }),
    ).rejects.toThrow(AttachmentTooLargeError);
  });

  it("refuses an unsupported type before spending a call", async () => {
    const before = generateCalls.length;
    await expect(
      analyseAttachment({ mediaType: "video/mp4", data: Buffer.from("x"), filename: "clip.mp4" }),
    ).rejects.toThrow(UnsupportedAttachmentError);
    expect(generateCalls.length).toBe(before);
  });

  it("sends a PDF as a pdf attachment", async () => {
    await analyseAttachment({ mediaType: "application/pdf", data: Buffer.from("%PDF-"), filename: "kit.pdf" });
    const attachments = generateCalls.at(-1)!.options.attachments as { kind: string; filename: string }[];
    expect(attachments[0]!.kind).toBe("pdf");
    expect(attachments[0]!.filename).toBe("kit.pdf");
  });

  it("sends an image as an image attachment and returns the parsed analysis", async () => {
    const result = await analyseAttachment({
      mediaType: "image/jpeg",
      data: Buffer.from("jpegbytes"),
      filename: "poster.jpg",
    });
    const attachments = generateCalls.at(-1)!.options.attachments as { kind: string; mediaType: string }[];
    expect(attachments[0]!.kind).toBe("image");
    expect(attachments[0]!.mediaType).toBe("image/jpeg");
    expect(result).toEqual({ summary: "a poster", facts: [] });
  });
});

describe("resolveMediaType", () => {
  it("keeps the mime type Telegram gave", async () => {
    const { resolveMediaType } = await import("../src/modules/knowledge/attachment.service.js");
    expect(resolveMediaType("application/pdf", "kit.pdf")).toBe("application/pdf");
  });

  it("falls back to the extension when Telegram omits the mime type", async () => {
    const { resolveMediaType } = await import("../src/modules/knowledge/attachment.service.js");
    expect(resolveMediaType(undefined, "Brand Book.PDF")).toBe("application/pdf");
    expect(resolveMediaType(undefined, "shot.jpeg")).toBe("image/jpeg");
    expect(resolveMediaType(undefined, "art.png")).toBe("image/png");
  });

  it("gives up on an extension it can't read", async () => {
    const { resolveMediaType } = await import("../src/modules/knowledge/attachment.service.js");
    expect(resolveMediaType(undefined, "track.wav")).toBeUndefined();
    expect(resolveMediaType(undefined, "noextension")).toBeUndefined();
  });
});
