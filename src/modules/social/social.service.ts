import type { SocialPlatform } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { decryptToken, encryptToken } from "../../lib/tokenCrypto.js";
import { recordAudit } from "../audit/audit.service.js";
import { InstagramAdapter } from "./instagram.adapter.js";
import type { ConnectedAccount, DraftPost, SocialPlatformAdapter, ValidationResult } from "./types.js";

const ADAPTERS: Partial<Record<SocialPlatform, SocialPlatformAdapter>> = {
  INSTAGRAM: new InstagramAdapter(),
};

export class NoAccountError extends Error {
  constructor(platform: SocialPlatform) {
    super(`No ${platform} account is connected. Use /connect to link one.`);
    this.name = "NoAccountError";
  }
}

export class UnsupportedPlatformError extends Error {
  constructor(platform: SocialPlatform) {
    super(`${platform} posting isn't built yet — only Instagram is wired up so far.`);
    this.name = "UnsupportedPlatformError";
  }
}

export function adapterFor(platform: SocialPlatform): SocialPlatformAdapter {
  const adapter = ADAPTERS[platform];
  if (!adapter) throw new UnsupportedPlatformError(platform);
  return adapter;
}

export async function connectAccount(input: {
  platform: SocialPlatform;
  platformAccountId: string;
  username?: string;
  accessToken: string;
  tokenExpiresAt?: Date;
}) {
  adapterFor(input.platform); // reject a platform we can't actually post to
  const accessToken = encryptToken(input.accessToken);

  const account = await prisma.socialAccount.upsert({
    where: {
      platform_platformAccountId: { platform: input.platform, platformAccountId: input.platformAccountId },
    },
    create: {
      platform: input.platform,
      platformAccountId: input.platformAccountId,
      username: input.username,
      accessToken,
      tokenExpiresAt: input.tokenExpiresAt,
    },
    update: { accessToken, username: input.username, tokenExpiresAt: input.tokenExpiresAt, isActive: true },
  });

  // Deliberately records no token material, not even a hint.
  await recordAudit({
    action: "social.account_connected",
    entityType: "SocialAccount",
    entityId: account.id,
    actorType: "ASHER",
    details: { platform: input.platform, platformAccountId: input.platformAccountId },
  });
  return account;
}

export async function disconnectAccount(platform: SocialPlatform) {
  const { count } = await prisma.socialAccount.updateMany({
    where: { platform, isActive: true },
    data: { isActive: false },
  });
  if (count > 0) {
    await recordAudit({
      action: "social.account_disconnected",
      entityType: "SocialAccount",
      actorType: "ASHER",
      details: { platform },
    });
  }
  return count;
}

export async function listConnectedAccounts() {
  return prisma.socialAccount.findMany({
    where: { isActive: true },
    select: { id: true, platform: true, platformAccountId: true, username: true, tokenExpiresAt: true, connectedAt: true },
    orderBy: { connectedAt: "desc" },
  });
}

/** Loads an account and decrypts its token for immediate use. */
export async function activeAccountFor(platform: SocialPlatform): Promise<{ id: string; connected: ConnectedAccount }> {
  const account = await prisma.socialAccount.findFirst({ where: { platform, isActive: true } });
  if (!account) throw new NoAccountError(platform);
  return {
    id: account.id,
    connected: {
      platform: account.platform,
      platformAccountId: account.platformAccountId,
      accessToken: decryptToken(account.accessToken),
    },
  };
}

export async function validateForPlatform(platform: SocialPlatform, post: DraftPost): Promise<ValidationResult> {
  return adapterFor(platform).validate(post);
}

/**
 * Publishes a post. Only ever called from the approved-action handler — there is
 * no path from a conversation straight to here, which is what keeps the agent
 * unable to post by talking itself into it.
 */
export async function publishPost(input: {
  platform: SocialPlatform;
  caption: string;
  mediaUrl?: string;
  assetId?: string;
}) {
  const { id: socialAccountId, connected } = await activeAccountFor(input.platform);
  const adapter = adapterFor(input.platform);

  const post = await prisma.socialPost.create({
    data: {
      socialAccountId,
      caption: input.caption,
      assetId: input.assetId,
      status: "AWAITING_APPROVAL",
    },
  });

  try {
    const result = await adapter.publish(connected, { caption: input.caption, mediaUrl: input.mediaUrl });
    return prisma.socialPost.update({
      where: { id: post.id },
      data: {
        status: "PUBLISHED",
        platformPostId: result.platformPostId,
        publishedAt: new Date(),
        dryRun: result.dryRun,
      },
    });
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : String(error);
    await prisma.socialPost.update({ where: { id: post.id }, data: { status: "FAILED", failureReason } });
    throw error;
  }
}

export async function listRecentPosts(limit = 10) {
  return prisma.socialPost.findMany({
    include: { socialAccount: { select: { platform: true, username: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
