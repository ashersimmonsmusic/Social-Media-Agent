import type { SocialPlatform } from "@prisma/client";

/** A post as the rest of the system describes it, before any platform specifics. */
export interface DraftPost {
  caption: string;
  /**
   * Publicly reachable media URL. Instagram fetches media from a URL rather
   * than accepting bytes, so this cannot be a local path or storage key.
   */
  mediaUrl?: string;
  /**
   * Whether `mediaUrl` points at a still or a clip. Instagram treats the two as
   * different post types with different parameters and a different publishing
   * sequence, and there is no way to infer which from the URL alone — the media
   * route serves both from the same path shape.
   */
  mediaKind?: "IMAGE" | "VIDEO";
}

export interface ValidationResult {
  ok: boolean;
  /** Human-readable reasons the post can't go out, safe to show Asher verbatim. */
  problems: string[];
}

export interface PublishResult {
  platformPostId: string;
  /** True when DRY_RUN stopped the call and nothing left the server. */
  dryRun: boolean;
}

export interface ConnectedAccount {
  platform: SocialPlatform;
  platformAccountId: string;
  /** Decrypted only in memory, at the point of use. Never logged. */
  accessToken: string;
}

/**
 * The contract from ARCHITECTURE.md §6, narrowed to what is actually built.
 * Scheduling, analytics and webhooks stay unimplemented rather than stubbed —
 * the interface there documents the eventual shape; this is today's subset.
 */
export interface SocialPlatformAdapter {
  readonly platform: SocialPlatform;
  validate(post: DraftPost): ValidationResult;
  publish(account: ConnectedAccount, post: DraftPost): Promise<PublishResult>;
}
