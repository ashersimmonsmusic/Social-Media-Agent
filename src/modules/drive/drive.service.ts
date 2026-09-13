import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../../config/env.js";
import { getAccessToken } from "../oauth/google.service.js";

export interface DriveVideo {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdTime: string;
  durationMillis?: number;
  width?: number;
  height?: number;
}

export class DriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveError";
  }
}

async function driveRequest(path: string, params: Record<string, string>): Promise<Response> {
  const token = await getAccessToken();
  const url = new URL(`https://www.googleapis.com/drive/v3/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const text = await response.text();
    throw new DriveError(`Google Drive refused that (${response.status}): ${text.slice(0, 200)}`);
  }
  return response;
}

interface DriveFileResponse {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime: string;
  videoMediaMetadata?: { durationMillis?: string; width?: number; height?: number };
}

function toVideo(file: DriveFileResponse): DriveVideo {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: Number(file.size ?? 0),
    createdTime: file.createdTime,
    durationMillis: file.videoMediaMetadata?.durationMillis
      ? Number(file.videoMediaMetadata.durationMillis)
      : undefined,
    width: file.videoMediaMetadata?.width,
    height: file.videoMediaMetadata?.height,
  };
}

const FILE_FIELDS = "id,name,mimeType,size,createdTime,videoMediaMetadata(durationMillis,width,height)";

/**
 * Lists videos, newest first. Restricted to a single folder when
 * GOOGLE_DRIVE_FOLDER_ID is set, which keeps the bot's reach to a folder Asher
 * chooses rather than his entire Drive.
 */
export async function listVideos(limit = 20): Promise<DriveVideo[]> {
  const clauses = ["mimeType contains 'video/'", "trashed = false"];
  if (env.GOOGLE_DRIVE_FOLDER_ID) clauses.push(`'${env.GOOGLE_DRIVE_FOLDER_ID}' in parents`);

  const response = await driveRequest("files", {
    q: clauses.join(" and "),
    orderBy: "createdTime desc",
    pageSize: String(Math.min(limit, 100)),
    fields: `files(${FILE_FIELDS})`,
    // Without these, files in a Shared Drive are simply invisible.
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });

  const json = (await response.json()) as { files?: DriveFileResponse[] };
  return (json.files ?? []).map(toVideo);
}

export async function getVideo(fileId: string): Promise<DriveVideo> {
  const response = await driveRequest(`files/${encodeURIComponent(fileId)}`, {
    fields: FILE_FIELDS,
    supportsAllDrives: "true",
  });
  return toVideo((await response.json()) as DriveFileResponse);
}

/**
 * Downloads a file's bytes. Deliberately capped: video is far larger than
 * anything else this app handles, and an unbounded read would exhaust the
 * container's memory rather than failing cleanly.
 */
export async function downloadVideo(fileId: string, maxBytes: number): Promise<Buffer> {
  const meta = await getVideo(fileId);
  if (meta.sizeBytes > maxBytes) {
    throw new DriveError(
      `${meta.name} is ${(meta.sizeBytes / 1024 / 1024).toFixed(0)}MB, over the ${(maxBytes / 1024 / 1024).toFixed(0)}MB limit for processing.`,
    );
  }

  const response = await driveRequest(`files/${encodeURIComponent(fileId)}`, {
    alt: "media",
    supportsAllDrives: "true",
  });
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Streams a file straight to disk instead of through memory.
 *
 * `downloadVideo` above returns a Buffer, which is fine for something small but
 * would hold a whole clip in RAM at once — and video is the one thing here big
 * enough for that to kill the container. ffmpeg needs a real file on disk
 * anyway, so for video this is both lighter and what the next step wants.
 */
export async function downloadToFile(fileId: string, destination: string, maxBytes: number): Promise<DriveVideo> {
  const meta = await getVideo(fileId);
  if (meta.sizeBytes > maxBytes) {
    throw new DriveError(
      `${meta.name} is ${(meta.sizeBytes / 1024 / 1024).toFixed(0)}MB, over the ` +
        `${(maxBytes / 1024 / 1024).toFixed(0)}MB limit I can process. Export a smaller version and try again.`,
    );
  }

  const response = await driveRequest(`files/${encodeURIComponent(fileId)}`, {
    alt: "media",
    supportsAllDrives: "true",
  });
  if (!response.body) throw new DriveError(`Google Drive sent nothing for ${meta.name}.`);

  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(destination));
  return meta;
}

export function formatDuration(millis?: number): string {
  if (!millis) return "unknown length";
  const total = Math.round(millis / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatVideoList(videos: DriveVideo[]): string {
  if (videos.length === 0) {
    return env.GOOGLE_DRIVE_FOLDER_ID
      ? "No videos in the folder I'm watching. Drop one in and ask again."
      : "No videos found in your Drive.";
  }
  return videos
    .map((video) => {
      const size = `${(video.sizeBytes / 1024 / 1024).toFixed(0)}MB`;
      const shape = video.width && video.height ? `${video.width}x${video.height}` : "unknown size";
      return `• ${video.name}\n  ${formatDuration(video.durationMillis)} | ${size} | ${shape}\n  id: ${video.id}`;
    })
    .join("\n");
}
