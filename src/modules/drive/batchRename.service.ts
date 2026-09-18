import { prisma } from "../../db/prisma.js";
import { logger } from "../../lib/logger.js";
import { recordAudit } from "../audit/audit.service.js";
import { listVideos, renameFile, type DriveVideo } from "./drive.service.js";
import { looksUnnamed, suggestFromFrames, suggestFromTranscript } from "./naming.service.js";

/**
 * Renaming a folder's worth of camera-named files in one go.
 *
 * Two things shape this. Suggesting a name is free for a video that has been
 * transcribed and costs a whole download for one that hasn't — so the cheap
 * ones are done by default and the expensive ones are quoted rather than
 * quietly run. And renaming fifteen files at once is the largest change the bot
 * can make to his Drive, so nothing happens without the whole list in front of
 * him first.
 */

/** Enough to be useful in one go, few enough to read before agreeing. */
const MAX_BATCH = 15;

/** Downloading more than this in one command is not a thing to do unasked. */
const MAX_DEEP_LOOKS = 5;

export interface RenamePlanEntry {
  fileId: string;
  from: string;
  to: string;
  basis: "transcript" | "frames";
}

export interface RenamePlan {
  entries: RenamePlanEntry[];
  /** Named but not renameable for free — quoted rather than run. */
  needLooking: DriveVideo[];
  /** Files whose names already say something. */
  skipped: number;
}

/**
 * Works out what could be renamed.
 *
 * `deep` decides whether videos nothing has read are downloaded and looked at.
 * Off by default: a folder of twenty untouched clips is several gigabytes of
 * transfer, and that should be a decision rather than a side effect.
 */
export async function planBatchRename(deep = false): Promise<RenamePlan> {
  const videos = await listVideos(60);
  const candidates = videos.filter((video) => looksUnnamed(video.name));
  const skipped = videos.length - candidates.length;

  const entries: RenamePlanEntry[] = [];
  const needLooking: DriveVideo[] = [];

  for (const video of candidates.slice(0, MAX_BATCH)) {
    if (entries.length >= MAX_BATCH) break;

    try {
      const fromTranscript = await suggestFromTranscript(video.id);
      if (fromTranscript) {
        entries.push({ fileId: video.id, from: video.name, to: fromTranscript, basis: "transcript" });
        continue;
      }
    } catch (error) {
      logger.warn("batchRename.transcript_failed", { fileId: video.id, error: String(error) });
    }

    if (!deep) {
      needLooking.push(video);
      continue;
    }

    if (entries.filter((entry) => entry.basis === "frames").length >= MAX_DEEP_LOOKS) {
      needLooking.push(video);
      continue;
    }

    try {
      const fromFrames = await suggestFromFrames(video.id);
      if (fromFrames) {
        entries.push({ fileId: video.id, from: video.name, to: fromFrames, basis: "frames" });
      } else {
        needLooking.push(video);
      }
    } catch (error) {
      // One unreadable file should not lose the rest of the batch.
      logger.warn("batchRename.frames_failed", { fileId: video.id, error: String(error) });
      needLooking.push(video);
    }
  }

  return { entries, needLooking, skipped };
}

export interface BatchResult {
  renamed: { from: string; to: string }[];
  failed: { from: string; reason: string }[];
  batchId: string;
}

/**
 * Applies a plan, and records it as one batch so it can be undone as one.
 *
 * Fifteen individual undos is not an undo.
 */
export async function applyBatchRename(entries: RenamePlanEntry[]): Promise<BatchResult> {
  const batchId = `batch-${Date.now()}`;
  const renamed: { from: string; to: string }[] = [];
  const failed: { from: string; reason: string }[] = [];
  // Tracked by id rather than by name: renameFile puts the extension back, so
  // what it returns is not the string that was asked for, and matching on the
  // name would record an empty batch — an undo that silently does nothing.
  const succeeded = new Set<string>();

  for (const entry of entries) {
    try {
      const result = await renameFile(entry.fileId, entry.to);
      renamed.push(result);
      succeeded.add(entry.fileId);
      await prisma.sourceVideo.updateMany({ where: { driveFileId: entry.fileId }, data: { filename: result.to } });
    } catch (error) {
      failed.push({ from: entry.from, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  if (renamed.length > 0) {
    await recordAudit({
      action: "drive.batch_renamed",
      entityType: "DriveBatch",
      entityId: batchId,
      actorType: "ASHER",
      details: {
        // Every pair, because this is what an undo reads back.
        renames: entries
          .filter((entry) => succeeded.has(entry.fileId))
          .map((entry) => ({ fileId: entry.fileId, from: entry.from, to: entry.to })),
      },
    });
  }

  logger.info("batchRename.applied", { batchId, renamed: renamed.length, failed: failed.length });
  return { renamed, failed, batchId };
}

interface StoredRename {
  fileId: string;
  from: string;
  to: string;
}

/**
 * Puts the last batch back.
 *
 * The audit log keeps every previous name, which is what makes a bulk rename
 * safe to agree to: the worst case is one command, not an afternoon.
 */
export async function undoLastBatchRename(): Promise<{ restored: number; failed: number } | null> {
  const entry = await prisma.auditLog.findFirst({
    where: { action: "drive.batch_renamed" },
    orderBy: { createdAt: "desc" },
  });
  if (!entry) return null;

  const renames = ((entry.details as { renames?: StoredRename[] } | null)?.renames ?? []).filter(
    (rename) => rename.fileId && rename.from,
  );
  if (renames.length === 0) return null;

  let restored = 0;
  let failed = 0;
  for (const rename of renames) {
    try {
      // The stored name includes its extension; renameFile re-adds one only if
      // it is missing, so putting the original back is exact.
      await renameFile(rename.fileId, rename.from.replace(/\.[^.]+$/, ""));
      await prisma.sourceVideo.updateMany({ where: { driveFileId: rename.fileId }, data: { filename: rename.from } });
      restored += 1;
    } catch (error) {
      logger.warn("batchRename.undo_failed", { fileId: rename.fileId, error: String(error) });
      failed += 1;
    }
  }

  await recordAudit({
    action: "drive.batch_rename_undone",
    entityType: "DriveBatch",
    entityId: entry.entityId ?? "unknown",
    actorType: "ASHER",
    details: { restored, failed },
  });

  return { restored, failed };
}

export function formatPlan(plan: RenamePlan): string {
  const lines = ["RENAME PLAN", ""];

  if (plan.entries.length === 0) {
    lines.push("Nothing I can name for free right now.");
  } else {
    lines.push(`${plan.entries.length} I can rename:`, "");
    for (const entry of plan.entries) {
      lines.push(`${entry.from}`, `  ↓ ${entry.to}`, "");
    }
  }

  if (plan.needLooking.length > 0) {
    const mb = Math.round(plan.needLooking.reduce((sum, video) => sum + video.sizeBytes, 0) / 1024 / 1024);
    lines.push(
      `${plan.needLooking.length} more I'd have to watch first — nothing has read them. ` +
        `That's about ${mb}MB of downloading. Send /rename all deep if you want me to.`,
      "",
    );
  }

  if (plan.skipped > 0) {
    lines.push(`${plan.skipped} already have names, so I left them alone.`);
  }

  return lines.join("\n");
}
