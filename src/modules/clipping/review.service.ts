import { prisma } from "../../db/prisma.js";
import { recordAudit } from "../audit/audit.service.js";
import { CRITERIA } from "./craft.js";

/**
 * Reviewing what the analysis found.
 *
 * Every decision is recorded rather than just applied. Which clips he keeps and
 * which he throws away is the only real signal about what a good Asher clip is,
 * and it is worth having long before anything reads it.
 */

export type SortBy = "score" | "duration" | "newest" | "topic";

export async function listClips(options: { videoId?: string; sortBy?: SortBy; includeRejected?: boolean } = {}) {
  const orderBy =
    options.sortBy === "duration"
      ? [{ endSeconds: "desc" as const }]
      : options.sortBy === "newest"
        ? [{ createdAt: "desc" as const }]
        : options.sortBy === "topic"
          ? [{ topic: "asc" as const }, { rank: "asc" as const }]
          : [{ rank: "asc" as const }];

  return prisma.clip.findMany({
    where: {
      ...(options.videoId ? { sourceVideoId: options.videoId } : {}),
      ...(options.includeRejected ? {} : { decision: { not: "REJECTED" as const } }),
    },
    orderBy,
    include: { sourceVideo: { select: { filename: true } } },
    take: 25,
  });
}

/** The most recent video with clips, which is what /clips means with no argument. */
export async function latestAnalysedVideo() {
  return prisma.sourceVideo.findFirst({
    where: { clips: { some: {} } },
    orderBy: { completedAt: "desc" },
    include: { _count: { select: { clips: true } } },
  });
}

export async function decideClip(rank: number, decision: "SELECTED" | "REJECTED", videoId?: string) {
  const video = videoId ? { id: videoId } : await latestAnalysedVideo();
  if (!video) return null;

  const clip = await prisma.clip.findFirst({ where: { sourceVideoId: video.id, rank } });
  if (!clip) return null;

  const updated = await prisma.clip.update({
    where: { id: clip.id },
    data: { decision, decidedAt: new Date() },
  });

  // The signal, not the side effect: what he keeps and drops is the only honest
  // measure of whether the scoring is any good.
  await recordAudit({
    action: decision === "SELECTED" ? "clipping.clip_selected" : "clipping.clip_rejected",
    entityType: "Clip",
    entityId: clip.id,
    actorType: "ASHER",
    details: { title: clip.title, score: clip.score, rank: clip.rank, topic: clip.topic },
  });

  return updated;
}

export async function selectTop(count: number, videoId?: string): Promise<number> {
  const video = videoId ? { id: videoId } : await latestAnalysedVideo();
  if (!video) return 0;

  const clips = await prisma.clip.findMany({
    where: { sourceVideoId: video.id, decision: "PENDING" },
    orderBy: { rank: "asc" },
    take: count,
  });

  for (const clip of clips) await decideClip(clip.rank, "SELECTED", video.id);
  return clips.length;
}

function timestamp(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

/** The strongest and weakest things about a clip, from its own breakdown. */
export function scoreHighlights(scores: Record<string, unknown>): string {
  const entries = CRITERIA.map(([key]) => [key, Number(scores[key]) || 0] as const)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return "";

  const best = entries.slice(0, 2).map(([key, value]) => `${key} ${value}`);
  const worst = entries.at(-1)!;
  // The weakest number is the useful one — it says what he is trading away.
  return `strongest: ${best.join(", ")} · weakest: ${worst[0]} ${worst[1]}`;
}

export interface ClipForDisplay {
  rank: number;
  title: string;
  score: number;
  scores: unknown;
  startSeconds: number;
  endSeconds: number;
  reason: string;
  transcript: string;
  topic: string | null;
  suggestedPlatforms: string[];
  decision: string;
  assetId: string | null;
}

export function formatClip(clip: ClipForDisplay): string {
  const duration = Math.round(clip.endSeconds - clip.startSeconds);
  const mark = clip.decision === "SELECTED" ? " ✓ selected" : clip.decision === "REJECTED" ? " ✗ rejected" : "";

  const lines = [
    `${String(clip.rank).padStart(2, "0")} — ${clip.title.toUpperCase()}${mark}`,
    `${clip.score}/100 · ${duration}s · ${timestamp(clip.startSeconds)}→${timestamp(clip.endSeconds)}`,
  ];

  const highlights = scoreHighlights((clip.scores ?? {}) as Record<string, unknown>);
  if (highlights) lines.push(highlights);

  lines.push("", clip.reason);

  if (clip.transcript) {
    const said = clip.transcript.length > 300 ? `${clip.transcript.slice(0, 300)}…` : clip.transcript;
    lines.push("", `"${said}"`);
  }

  if (clip.suggestedPlatforms.length > 0) {
    lines.push("", `Suits: ${clip.suggestedPlatforms.join(", ")}`);
  }
  if (!clip.assetId) {
    lines.push("", "Not cut yet — it's outside the top few I rendered up front.");
  }

  return lines.join("\n");
}

export async function selectionSummary(videoId?: string) {
  const video = videoId ? { id: videoId } : await latestAnalysedVideo();
  if (!video) return null;

  const [selected, rejected, pending] = await Promise.all([
    prisma.clip.count({ where: { sourceVideoId: video.id, decision: "SELECTED" } }),
    prisma.clip.count({ where: { sourceVideoId: video.id, decision: "REJECTED" } }),
    prisma.clip.count({ where: { sourceVideoId: video.id, decision: "PENDING" } }),
  ]);
  return { videoId: video.id, selected, rejected, pending };
}
