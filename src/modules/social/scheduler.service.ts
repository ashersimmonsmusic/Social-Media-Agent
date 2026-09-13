import type { SocialPlatform } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { logger } from "../../lib/logger.js";
import { recordAudit } from "../audit/audit.service.js";
import { adapterFor, activeAccountFor, mediaForAsset, NoAccountError } from "./social.service.js";

/**
 * How late a post may be before it's abandoned rather than published.
 *
 * If the app is down overnight, waking up and firing six hours of backlog at
 * once is worse than not posting: the timing was the point, and a stale
 * "playing tonight" post is actively wrong.
 */
const MAX_LATENESS_MS = 2 * 60 * 60 * 1000;

/** A post must be at least this far out, so there's room to cancel it. */
export const MIN_LEAD_MS = 60 * 1000;

export class SchedulingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulingError";
  }
}

export async function schedulePost(input: {
  platform: SocialPlatform;
  caption: string;
  assetId?: string;
  scheduledFor: Date;
}) {
  if (Number.isNaN(input.scheduledFor.getTime())) {
    throw new SchedulingError("I couldn't read that time.");
  }
  if (input.scheduledFor.getTime() - Date.now() < MIN_LEAD_MS) {
    throw new SchedulingError("That time has already passed, or is too close to now to schedule.");
  }

  // Fail here rather than at publish time: an account that isn't connected
  // would otherwise only surface as a failure long after he'd walked away.
  const { id: socialAccountId } = await activeAccountFor(input.platform);

  const post = await prisma.socialPost.create({
    data: {
      socialAccountId,
      caption: input.caption,
      assetId: input.assetId,
      status: "SCHEDULED",
      scheduledFor: input.scheduledFor,
    },
  });

  await recordAudit({
    action: "social.post_scheduled",
    entityType: "SocialPost",
    entityId: post.id,
    actorType: "ASHER",
    details: { platform: input.platform, scheduledFor: input.scheduledFor.toISOString() },
  });

  return post;
}

export async function listScheduledPosts() {
  return prisma.socialPost.findMany({
    where: { status: { in: ["SCHEDULED", "PUBLISHING"] } },
    include: { socialAccount: { select: { platform: true, username: true } } },
    orderBy: { scheduledFor: "asc" },
  });
}

export async function cancelScheduledPost(id: string) {
  const { count } = await prisma.socialPost.updateMany({
    where: { id, status: "SCHEDULED" },
    data: { status: "CANCELLED" },
  });
  if (count > 0) {
    await recordAudit({ action: "social.post_cancelled", entityType: "SocialPost", entityId: id, actorType: "ASHER" });
  }
  return count > 0;
}

/**
 * Takes ownership of one due post by moving it out of SCHEDULED in a single
 * conditional update. Whichever caller's update reports a row wins; any other
 * caller sees zero and moves on, so a restart mid-run or a second instance
 * can't publish the same post twice.
 */
async function claimNextDuePost() {
  const candidate = await prisma.socialPost.findFirst({
    where: { status: "SCHEDULED", scheduledFor: { lte: new Date() } },
    orderBy: { scheduledFor: "asc" },
    include: { socialAccount: { select: { platform: true } } },
  });
  if (!candidate) return null;

  const { count } = await prisma.socialPost.updateMany({
    where: { id: candidate.id, status: "SCHEDULED" },
    data: { status: "PUBLISHING" },
  });
  return count === 1 ? candidate : null;
}

async function publishClaimedPost(post: {
  id: string;
  caption: string;
  assetId: string | null;
  scheduledFor: Date | null;
  socialAccount: { platform: SocialPlatform };
}) {
  const platform = post.socialAccount.platform;

  const lateBy = post.scheduledFor ? Date.now() - post.scheduledFor.getTime() : 0;
  if (lateBy > MAX_LATENESS_MS) {
    await prisma.socialPost.update({
      where: { id: post.id },
      data: {
        status: "FAILED",
        failureReason: `Missed its slot by ${Math.round(lateBy / 60000)} minutes, so I didn't post it late.`,
      },
    });
    logger.warn("social.scheduled_post_missed", { postId: post.id, lateByMs: lateBy });
    return;
  }

  try {
    // Media links are minted now, not when it was scheduled — a link signed
    // days ago would have expired long before this runs.
    const media = post.assetId ? await mediaForAsset(post.assetId) : undefined;
    const { connected } = await activeAccountFor(platform);

    const result = await adapterFor(platform).publish(connected, {
      caption: post.caption,
      mediaUrl: media?.mediaUrl,
      mediaKind: media?.mediaKind,
    });
    await prisma.socialPost.update({
      where: { id: post.id },
      data: {
        status: "PUBLISHED",
        platformPostId: result.platformPostId,
        publishedAt: new Date(),
        dryRun: result.dryRun,
      },
    });
    logger.info("social.scheduled_post_published", { postId: post.id, dryRun: result.dryRun });
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : String(error);
    await prisma.socialPost.update({ where: { id: post.id }, data: { status: "FAILED", failureReason } });
    logger.error("social.scheduled_post_failed", { postId: post.id, error: failureReason });
  }
}

/** Publishes everything currently due. Exported so a test can drive one pass. */
export async function runDuePosts(): Promise<number> {
  let published = 0;
  for (;;) {
    let post;
    try {
      post = await claimNextDuePost();
    } catch (error) {
      logger.error("social.scheduler_claim_failed", { error: String(error) });
      return published;
    }
    if (!post) return published;

    await publishClaimedPost(post);
    published += 1;
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Runs the queue in-process on a timer rather than as a separate cron service:
 * the app is already always-on, and the atomic claim above is what actually
 * makes duplicate publishing impossible, not the number of runners.
 */
export function startScheduler(intervalMs = 60_000) {
  if (timer) return;
  timer = setInterval(() => {
    void runDuePosts().catch((error) => logger.error("social.scheduler_tick_failed", { error: String(error) }));
  }, intervalMs);
  // Don't hold the process open purely for the timer.
  timer.unref?.();
  logger.info("social.scheduler_started", { intervalMs });
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export { NoAccountError };
