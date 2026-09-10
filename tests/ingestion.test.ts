import { describe, expect, it } from "vitest";
import { classifyContent } from "../src/modules/assets/ingestion.service.js";

describe("classifyContent", () => {
  it("classifies images by mimetype", () => {
    expect(classifyContent({ filename: "cover.jpg", mimeType: "image/jpeg" }).assetType).toBe("PHOTO");
  });

  it("classifies images by extension when mimetype is missing", () => {
    expect(classifyContent({ filename: "flyer.png" }).assetType).toBe("PHOTO");
  });

  it("classifies video files", () => {
    expect(classifyContent({ filename: "studio-session.mp4", mimeType: "video/mp4" }).assetType).toBe("VIDEO");
  });

  it("classifies audio files", () => {
    expect(classifyContent({ filename: "brighter-days.wav" }).assetType).toBe("AUDIO");
  });

  it("classifies PDFs as documents", () => {
    expect(classifyContent({ filename: "press-release.pdf", mimeType: "application/pdf" }).assetType).toBe("DOCUMENT");
  });

  it("classifies a bare URL as URL", () => {
    expect(classifyContent({ text: "https://open.spotify.com/track/abc123" }).assetType).toBe("URL");
  });

  it("classifies quoted text as TEXT with a quotation hint", () => {
    const result = classifyContent({ text: '"Sometimes the hardest part is believing."' });
    expect(result.assetType).toBe("TEXT");
    expect(result.reason).toMatch(/quotation/i);
  });

  it("classifies plain text drops as TEXT", () => {
    expect(classifyContent({ text: "Studio session went well today" }).assetType).toBe("TEXT");
  });

  it("falls back to OTHER for unrecognised file types", () => {
    expect(classifyContent({ filename: "data.xyz" }).assetType).toBe("OTHER");
  });
});
