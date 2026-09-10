import type { AssetType } from "@prisma/client";

const PHOTO_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff"]);
const VIDEO_EXT = new Set(["mp4", "mov", "avi", "mkv", "webm", "m4v"]);
const AUDIO_EXT = new Set(["mp3", "wav", "aac", "m4a", "ogg", "flac", "opus"]);
// A dedicated "MUSIC" classification (vs generic AUDIO) matters because
// music assets feed the future Music Library (brief §7), while a voice
// note is just an audio asset. Phase 1 can't reliably tell them apart from
// the file alone, so both land as AUDIO for now; callers may re-tag a file
// as MUSIC once metadata (ISRC, release association, etc.) is attached.
const DOCUMENT_EXT = new Set(["pdf", "doc", "docx", "txt", "rtf", "odt"]);

export interface ClassifyInput {
  filename?: string;
  mimeType?: string;
  /** Raw text content, when the "upload" is actually a pasted/forwarded text message. */
  text?: string;
}

export interface ClassifyResult {
  assetType: AssetType;
  reason: string;
}

/**
 * Automatic content-type identification per brief §5:
 *   Photo -> visual content, MP3/WAV -> music asset, Video -> video asset,
 *   PDF -> document, URL -> external reference,
 *   Text beginning with quotation marks -> potential quote/typography content.
 */
export function classifyContent(input: ClassifyInput): ClassifyResult {
  const { filename, mimeType, text } = input;

  if (text !== undefined) {
    const trimmed = text.trim();
    if (isUrl(trimmed)) {
      return { assetType: "URL", reason: "Text is a single URL" };
    }
    return { assetType: "TEXT", reason: quotationHint(trimmed) };
  }

  const ext = filename ? extensionOf(filename) : undefined;

  if (mimeType?.startsWith("image/") || (ext && PHOTO_EXT.has(ext))) {
    return { assetType: "PHOTO", reason: `Detected image (${mimeType ?? ext})` };
  }
  if (mimeType?.startsWith("video/") || (ext && VIDEO_EXT.has(ext))) {
    return { assetType: "VIDEO", reason: `Detected video (${mimeType ?? ext})` };
  }
  if (mimeType?.startsWith("audio/") || (ext && AUDIO_EXT.has(ext))) {
    return { assetType: "AUDIO", reason: `Detected audio (${mimeType ?? ext})` };
  }
  if (mimeType === "application/pdf" || ext === "pdf" || (ext && DOCUMENT_EXT.has(ext))) {
    return { assetType: "DOCUMENT", reason: `Detected document (${mimeType ?? ext})` };
  }

  return { assetType: "OTHER", reason: "Could not confidently classify file" };
}

function extensionOf(filename: string): string | undefined {
  const parts = filename.split(".");
  if (parts.length < 2) return undefined;
  return parts[parts.length - 1]!.toLowerCase();
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !value.includes(" ");
  } catch {
    return false;
  }
}

function quotationHint(text: string): string {
  if (text.startsWith('"') || text.startsWith("“") || text.startsWith("'")) {
    return "Text begins with a quotation mark — potential quote/typography content";
  }
  return "Plain text drop";
}
