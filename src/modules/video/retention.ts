import { env } from "../../config/env.js";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../lib/logger.js";
import { storage } from "../../storage/index.js";
import { recordAudit } from "../audit/audit.service.js";

/**
 * Deletes the bytes of rendered clips that have already gone out.
 *
 * A vertical render is the one genuinely large thing this app stores, and once
 * a post is published it is also the one thing of which two other copies exist:
 * Instagram's, and the original footage in Drive. Keeping it costs volume space
 * — capped at 5GB on Railway's Hobby plan — to hold a file nothing will read.
 *
 * Only the file is removed. The Asset row stays, so /stats, the post history and
 * the library still show what was made and when; it simply no longer has bytes
 * behind it.
 */

/** Long enough to re-post or re-check something from the same week. */
const DEFAULT_RETENTION_DAYS = 7;

export interface PurgeResult {
  purged: number;
  freedBytes: number;
}

function sizeOf(metadata: unknown): number {
  if (typeof metadata !== "object" || metadata === null) return 0;
  const value = (metadata as Record<string, unknown>).sizeBytes;
  return typeof value === "number" ? value : 0;
}

export async function purgeSpentVideoBytes(retentionDays = env.VIDEO_RETENTION_DAYS): Promise<PurgeResult> {
  const cutoff = new Date(Date.now() - Math.max(0, retentionDays) * 86_400_000);

  const candidates = await prisma.asset.findMany({
    where: {
      assetType: "VIDEO",
      storageKey: { not: "" },
      // Published, and long enough ago that he has moved on from it.
      socialPosts: { some: { status: "PUBLISHED", publishedAt: { lt: cutoff } } },
      // Never touch one still waiting to go out, whatever else is true of it:
      // an asset can carry several posts, and one of them being spent says
      // nothing about the others.
      NOT: { socialPosts: { some: { status: { in: ["SCHEDULED", "PUBLISHING", "AWAITING_APPROVAL", "DRAFT"] } } } },
    },
    select: { id: true, filename: true, storageKey: true, metadata: true },
    take: 200,
  });

  let purged = 0;
  let freedBytes = 0;

  for (const asset of candidates) {
    try {
      await storage.delete(asset.storageKey);
    } catch (error) {
      // A file already gone is the desired state, so the row is still cleared.
      logger.warn("video.purge_delete_failed", { assetId: asset.id, error: String(error) });
    }

    const bytes = sizeOf(asset.metadata);
    await prisma.asset.update({
      where: { id: asset.id },
      data: {
        storageKey: "",
        metadata: {
          ...(typeof asset.metadata === "object" && asset.metadata !== null ? (asset.metadata as object) : {}),
          purgedAt: new Date().toISOString(),
          purgedReason: "published and past the retention window",
        },
      },
    });

    await recordAudit({
      action: "video.bytes_purged",
      entityType: "Asset",
      entityId: asset.id,
      actorType: "SYSTEM",
      details: { filename: asset.filename, freedBytes: bytes },
    });

    purged += 1;
    freedBytes += bytes;
  }

  if (purged > 0) {
    logger.info("video.bytes_purged", { purged, freedMb: Math.round(freedBytes / 1024 / 1024) });
  }
  return { purged, freedBytes };
}

let timer: NodeJS.Timeout | null = null;

export function startRetention(intervalMs = 24 * 60 * 60 * 1000) {
  if (timer) return;
  // Once at startup too, so a container that was down over a run catches up
  // rather than letting a week's clips accumulate on a 5GB volume.
  void purgeSpentVideoBytes().catch((error) => logger.error("video.purge_failed", { error: String(error) }));
  timer = setInterval(() => {
    void purgeSpentVideoBytes().catch((error) => logger.error("video.purge_failed", { error: String(error) }));
  }, intervalMs);
  timer.unref?.();
  logger.info("video.retention_started", { intervalMs, retentionDays: env.VIDEO_RETENTION_DAYS });
}

export function stopRetention() {
  if (timer) clearInterval(timer);
  timer = null;
}
