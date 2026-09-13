import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../db/prisma.js";
import { ingestFile } from "../assets/asset.service.js";
import { recordAudit } from "../audit/audit.service.js";
import { downloadToFile, formatDuration } from "../drive/drive.service.js";
import { probe, renderVertical, withTempDir, REELS_MAX_SECONDS, VideoToolError, type ReframePlan } from "./ffmpeg.js";
import { decideReframe, type ReframeMode } from "./reframe.service.js";

export interface PrepareVideoInput {
  driveFileId: string;
  /** "auto" lets the model decide; the others override it. */
  mode?: ReframeMode;
  /** Where in the source clip to start, for footage longer than Instagram allows. */
  startSeconds?: number;
}

export interface PreparedVideo {
  assetId: string;
  filename: string;
  sourceName: string;
  sourceShape: string;
  outputSeconds: number;
  sizeBytes: number;
  strategy: ReframePlan["strategy"];
  reason: string;
  observations: string[];
  /** Set when the source was longer than Instagram allows and had to be cut. */
  trimmedFromSeconds?: number;
  startSeconds: number;
}

function slugForOutput(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  const safe = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${safe || "clip"}-vertical.mp4`;
}

/**
 * Turns one Drive video into a vertical clip in the content library, ready to be
 * proposed as a post.
 *
 * Nothing here publishes anything. The result is an Asset and a description of
 * what was done to it, so the decision Asher is asked to approve is the actual
 * finished clip rather than a promise about one.
 */
export async function prepareVideoForReels(input: PrepareVideoInput): Promise<PreparedVideo> {
  const maxBytes = env.VIDEO_MAX_SOURCE_MB * 1024 * 1024;
  const startSeconds = Math.max(0, input.startSeconds ?? 0);

  return withTempDir(async (dir) => {
    const sourcePath = join(dir, "source");
    const outputPath = join(dir, "vertical.mp4");

    const meta = await downloadToFile(input.driveFileId, sourcePath, maxBytes);
    const probed = await probe(sourcePath);

    if (startSeconds > 0 && startSeconds >= probed.durationSeconds) {
      throw new VideoToolError(
        `You asked me to start ${startSeconds}s in, but ${meta.name} is only ` +
          `${formatDuration(probed.durationSeconds * 1000)} long.`,
      );
    }

    const available = probed.durationSeconds - startSeconds;
    const trimmed = available > REELS_MAX_SECONDS;

    const decision = await decideReframe(sourcePath, probed, input.mode ?? "auto");
    await renderVertical(sourcePath, outputPath, decision.plan, probed, { startSeconds });

    const rendered = await readFile(outputPath);
    const { size } = await stat(outputPath);

    const asset = await ingestFile({
      filename: slugForOutput(meta.name),
      mimeType: "video/mp4",
      data: rendered,
      source: `Google Drive: ${meta.name}`,
      description:
        `Vertical 9:16 cut of ${meta.name}` +
        (decision.observations.length > 0 ? ` — ${decision.observations.slice(0, 3).join("; ")}` : ""),
    });

    const outputSeconds = Math.min(REELS_MAX_SECONDS, available);

    // Recorded so a later "why does this one have bars?" has an answer, and so
    // the same source isn't re-rendered blindly.
    await prisma.asset.update({
      where: { id: asset.id },
      data: {
        metadata: {
          sizeBytes: size,
          driveFileId: input.driveFileId,
          sourceName: meta.name,
          sourceWidth: probed.width,
          sourceHeight: probed.height,
          reframeStrategy: decision.plan.strategy,
          reframeReason: decision.reason,
          startSeconds,
          outputSeconds,
        },
      },
    });

    await recordAudit({
      action: "video.prepared",
      entityType: "Asset",
      entityId: asset.id,
      actorType: "AI",
      details: { driveFileId: input.driveFileId, strategy: decision.plan.strategy, outputSeconds },
    });

    logger.info("video.prepared", {
      assetId: asset.id,
      strategy: decision.plan.strategy,
      sizeBytes: size,
      outputSeconds,
    });

    return {
      assetId: asset.id,
      filename: asset.filename,
      sourceName: meta.name,
      sourceShape: `${probed.width}x${probed.height}`,
      outputSeconds,
      sizeBytes: size,
      strategy: decision.plan.strategy,
      reason: decision.reason,
      observations: decision.observations,
      trimmedFromSeconds: trimmed ? probed.durationSeconds : undefined,
      startSeconds,
    };
  });
}

/** Renders the outcome for Telegram and for the agent to read as a tool result. */
export function formatPreparedVideo(result: PreparedVideo): string {
  const lines = [
    `Ready: ${result.filename}`,
    `From ${result.sourceName} (${result.sourceShape}) → 1080x1920`,
    `${result.outputSeconds.toFixed(0)}s | ${(result.sizeBytes / 1024 / 1024).toFixed(1)}MB`,
    "",
    result.reason,
  ];

  if (result.trimmedFromSeconds) {
    lines.push(
      "",
      `The source is ${formatDuration(result.trimmedFromSeconds * 1000)} long and Instagram's API caps Reels at ` +
        `${REELS_MAX_SECONDS} seconds, so I used ${result.startSeconds === 0 ? "the first" : `${result.startSeconds}s in for`} ` +
        `${result.outputSeconds.toFixed(0)} seconds. Tell me a different start point if the good bit is elsewhere.`,
    );
  }

  lines.push("", `Asset id: ${result.assetId}`);
  return lines.join("\n");
}
