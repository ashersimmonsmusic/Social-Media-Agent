import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "../../config/env.js";
import { getAccessToken } from "../oauth/google.service.js";
import { isServiceAccountConfigured, serviceAccountEmail } from "../oauth/serviceAccount.js";

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

const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Drive has no recursive query — `'x' in parents` matches direct children only.
 * So the tree is walked instead, with limits: nobody organises footage sixty
 * folders deep, and an unbounded walk on a large Drive is a lot of API calls
 * against a quota shared with everything else the bot does.
 */
const MAX_FOLDER_DEPTH = 6;
const MAX_FOLDERS = 150;
/** Drive rejects an over-long query, so parents are asked for in batches. */
const PARENTS_PER_QUERY = 25;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Every folder inside `rootId`, including itself.
 *
 * Asher files things the way anyone does — a folder per shoot, a folder per
 * month — and telling him to keep it flat instead was solving this in the wrong
 * place.
 */
export async function collectFolderIds(rootId: string): Promise<string[]> {
  const found = [rootId];
  let frontier = [rootId];

  for (let depth = 0; depth < MAX_FOLDER_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];

    for (const batch of chunk(frontier, PARENTS_PER_QUERY)) {
      const parents = batch.map((id) => `'${id}' in parents`).join(" or ");
      const response = await driveRequest("files", {
        q: `mimeType = '${FOLDER_MIME}' and trashed = false and (${parents})`,
        pageSize: "100",
        fields: "files(id)",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      const json = (await response.json()) as { files?: { id: string }[] };
      for (const folder of json.files ?? []) {
        if (found.includes(folder.id)) continue; // a folder can have two parents
        found.push(folder.id);
        next.push(folder.id);
        if (found.length >= MAX_FOLDERS) return found;
      }
    }
    frontier = next;
  }

  return found;
}

/**
 * Lists videos, newest first.
 *
 * With GOOGLE_DRIVE_FOLDER_ID set this covers the folder and everything nested
 * inside it; without it, every video the account can see.
 */
export async function listVideos(limit = 20): Promise<DriveVideo[]> {
  const pageSize = String(Math.min(Math.max(limit, 1), 100));
  const base = ["mimeType contains 'video/'", "trashed = false"];

  if (!env.GOOGLE_DRIVE_FOLDER_ID) {
    const response = await driveRequest("files", {
      q: base.join(" and "),
      orderBy: "createdTime desc",
      pageSize,
      fields: `files(${FILE_FIELDS})`,
      // Without these, files in a Shared Drive are simply invisible.
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    const json = (await response.json()) as { files?: DriveFileResponse[] };
    return (json.files ?? []).map(toVideo);
  }

  const folderIds = await collectFolderIds(env.GOOGLE_DRIVE_FOLDER_ID);
  const collected = new Map<string, DriveVideo>();

  for (const batch of chunk(folderIds, PARENTS_PER_QUERY)) {
    const parents = batch.map((id) => `'${id}' in parents`).join(" or ");
    const response = await driveRequest("files", {
      q: `${base.join(" and ")} and (${parents})`,
      orderBy: "createdTime desc",
      pageSize,
      fields: `files(${FILE_FIELDS})`,
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    const json = (await response.json()) as { files?: DriveFileResponse[] };
    // Keyed by id because a file living in two folders would otherwise appear twice.
    for (const file of json.files ?? []) collected.set(file.id, toVideo(file));
  }

  // Each batch was sorted on its own, so the merged set needs sorting again.
  return [...collected.values()]
    .sort((a, b) => b.createdTime.localeCompare(a.createdTime))
    .slice(0, limit);
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
    // With a service account this is almost always the folder not being shared
    // rather than the folder being empty — the API reports both identically.
    if (isServiceAccountConfigured()) {
      const email = serviceAccountEmail();
      return [
        "I can't see any videos.",
        "",
        email
          ? `If you haven't already, open the folder in Drive, press Share, and add this address as a Viewer:\n${email}`
          : "Check GOOGLE_SERVICE_ACCOUNT_JSON in Railway — I couldn't read the address to share with.",
        "",
        "If you have shared it, then the folder is empty. Subfolders are fine — I look inside those too.",
      ].join("\n");
    }
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
