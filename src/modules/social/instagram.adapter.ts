import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { recordAudit } from "../audit/audit.service.js";
import type { ConnectedAccount, DraftPost, PublishResult, SocialPlatformAdapter, ValidationResult } from "./types.js";

const MAX_CAPTION_CHARS = 2200;
const MAX_HASHTAGS = 30;

/**
 * How long to wait for Instagram to finish transcoding an uploaded video.
 *
 * Image containers are ready the moment the call returns; video containers are
 * not, and publishing one before it reports FINISHED fails. Meta's guidance is
 * to check about once a minute for no more than five, and most clips are done
 * inside two, so five minutes is the ceiling and anything past it is treated as
 * a failure rather than waited on indefinitely.
 */
const CONTAINER_READY_TIMEOUT_MS = 5 * 60 * 1000;
const FIRST_POLL_DELAY_MS = 10_000;
const MAX_POLL_DELAY_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${path}`;
}

/**
 * Instagram publishing via the Graph API.
 *
 * Two things about this platform shape the code. Media is mandatory — there is
 * no text-only feed post — and media is fetched by Instagram from a public URL
 * rather than uploaded as bytes, so `mediaUrl` has to be reachable from the
 * internet. Publishing is therefore two calls: create a media container, then
 * publish that container.
 */
/** Overridable so a test can exercise the polling loop without real waits. */
export interface ContainerPolling {
  firstDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

export class InstagramAdapter implements SocialPlatformAdapter {
  readonly platform = "INSTAGRAM" as const;

  private readonly polling: ContainerPolling;

  constructor(polling: Partial<ContainerPolling> = {}) {
    this.polling = {
      firstDelayMs: polling.firstDelayMs ?? FIRST_POLL_DELAY_MS,
      maxDelayMs: polling.maxDelayMs ?? MAX_POLL_DELAY_MS,
      timeoutMs: polling.timeoutMs ?? CONTAINER_READY_TIMEOUT_MS,
    };
  }

  validate(post: DraftPost): ValidationResult {
    const problems: string[] = [];

    const caption = post.caption.trim();
    if (!caption) problems.push("The caption is empty.");
    if (caption.length > MAX_CAPTION_CHARS) {
      problems.push(`Caption is ${caption.length} characters; Instagram allows ${MAX_CAPTION_CHARS}.`);
    }

    const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
    if (hashtags.length > MAX_HASHTAGS) {
      problems.push(`${hashtags.length} hashtags; Instagram allows ${MAX_HASHTAGS}.`);
    }

    if (!post.mediaUrl) {
      problems.push("Instagram has no text-only post — this needs an image or video.");
    } else if (!/^https:\/\//i.test(post.mediaUrl)) {
      problems.push("Instagram fetches media over HTTPS, so the media URL must be public and https.");
    }

    return { ok: problems.length === 0, problems };
  }

  async publish(account: ConnectedAccount, post: DraftPost): Promise<PublishResult> {
    const validation = this.validate(post);
    if (!validation.ok) {
      throw new PublishError(`This post isn't valid for Instagram: ${validation.problems.join(" ")}`);
    }

    // ARCHITECTURE.md §6 makes this check mandatory for every adapter: under
    // DRY_RUN nothing may leave the server, and what would have happened is
    // recorded instead.
    if (env.DRY_RUN) {
      await recordAudit({
        action: "social.publish_dry_run",
        entityType: "SocialAccount",
        entityId: account.platformAccountId,
        actorType: "SYSTEM",
        details: {
          platform: this.platform,
          captionLength: post.caption.length,
          caption: post.caption,
          mediaUrl: post.mediaUrl,
        },
      });
      logger.info("social.publish_dry_run", { platform: this.platform });
      return { platformPostId: `dry-run-${Date.now()}`, dryRun: true };
    }

    const containerId = await this.createContainer(account, post);
    // Only video needs this; an image container is publishable straight away.
    if (post.mediaKind === "VIDEO") await this.awaitContainerReady(account, containerId);
    const publishedId = await this.publishContainer(account, containerId);

    await recordAudit({
      action: "social.published",
      entityType: "SocialAccount",
      entityId: account.platformAccountId,
      actorType: "ASHER",
      details: { platform: this.platform, platformPostId: publishedId },
    });

    return { platformPostId: publishedId, dryRun: false };
  }

  private async createContainer(account: ConnectedAccount, post: DraftPost): Promise<string> {
    const isVideo = post.mediaKind === "VIDEO";
    const body = new URLSearchParams({
      // Video goes up as a Reel: it is the only video post type the API
      // publishes, and an unqualified video_url is rejected without it.
      ...(isVideo ? { media_type: "REELS", video_url: post.mediaUrl! } : { image_url: post.mediaUrl! }),
      caption: post.caption,
      access_token: account.accessToken,
    });
    const json = await postForm(graphUrl(`${account.platformAccountId}/media`), body, "create the media container");
    const id = typeof json.id === "string" ? json.id : "";
    if (!id) throw new PublishError("Instagram accepted the media but returned no container id.");
    return id;
  }

  /**
   * Waits for a video container to finish transcoding on Instagram's side.
   *
   * The backoff is not politeness: the app has a couple of hundred Graph calls
   * an hour, and a tight poll on one upload would spend them all.
   */
  private async awaitContainerReady(account: ConnectedAccount, containerId: string): Promise<void> {
    const deadline = Date.now() + this.polling.timeoutMs;
    let delay = this.polling.firstDelayMs;

    for (;;) {
      await sleep(delay);

      const json = await getJson(
        graphUrl(containerId),
        { fields: "status_code,status", access_token: account.accessToken },
        "check whether the video finished uploading",
      );
      const code = typeof json.status_code === "string" ? json.status_code : "";
      const detail = typeof json.status === "string" ? json.status : "";

      if (code === "FINISHED") {
        logger.info("social.video_container_ready", { platform: this.platform });
        return;
      }
      if (code === "ERROR") {
        throw new PublishError(
          `Instagram rejected the video while processing it${detail ? `: ${detail}` : "."} ` +
            `It needs to be MP4 with H.264 video and AAC audio, and no longer than 90 seconds.`,
        );
      }
      if (code === "EXPIRED") {
        throw new PublishError("The upload expired before it could be published. Try again.");
      }

      if (Date.now() >= deadline) {
        throw new PublishError(
          `Instagram is still processing the video after ${Math.round(this.polling.timeoutMs / 60000)} minutes, ` +
            "so I stopped waiting. Nothing was posted — try again, or use a shorter clip.",
        );
      }
      delay = Math.min(Math.round(delay * 1.5), this.polling.maxDelayMs);
    }
  }

  private async publishContainer(account: ConnectedAccount, containerId: string): Promise<string> {
    const body = new URLSearchParams({ creation_id: containerId, access_token: account.accessToken });
    const json = await postForm(graphUrl(`${account.platformAccountId}/media_publish`), body, "publish the post");
    const id = typeof json.id === "string" ? json.id : "";
    if (!id) throw new PublishError("Instagram published the container but returned no post id.");
    return id;
  }
}

/**
 * Posts a form body and surfaces Graph API errors as readable text. The token
 * is in the body, so nothing here logs the request.
 */
async function postForm(url: string, body: URLSearchParams, what: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (error) {
    throw new PublishError(`Couldn't reach Instagram to ${what}: ${error instanceof Error ? error.message : error}`);
  }

  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // fall through — a non-JSON body is reported via the status below
  }

  if (!response.ok) {
    const error = json.error as { message?: string; code?: number } | undefined;
    throw new PublishError(
      `Instagram refused to ${what} (${response.status})` +
        (error?.message ? `: ${error.message}` : `: ${text.slice(0, 200)}`),
    );
  }
  return json;
}

/**
 * Reads a Graph endpoint. The token goes in the query string because that is
 * what Graph accepts for GET, so the URL itself is never logged.
 */
async function getJson(
  url: string,
  params: Record<string, string>,
  what: string,
): Promise<Record<string, unknown>> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);

  let response: Response;
  try {
    response = await fetch(target, { method: "GET" });
  } catch (error) {
    throw new PublishError(`Couldn't reach Instagram to ${what}: ${error instanceof Error ? error.message : error}`);
  }

  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // fall through — the status below reports a non-JSON body
  }

  if (!response.ok) {
    const error = json.error as { message?: string } | undefined;
    throw new PublishError(
      `Instagram refused to ${what} (${response.status})` +
        (error?.message ? `: ${error.message}` : `: ${text.slice(0, 200)}`),
    );
  }
  return json;
}
