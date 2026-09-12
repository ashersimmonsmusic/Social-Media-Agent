import type { Telegraf } from "telegraf";
import { env } from "../../config/env.js";
import { registerApprovalAction } from "../../modules/approvals/actions.js";
import type { ApprovalPayload } from "../../modules/approvals/approval.service.js";
import {
  connectAccount,
  disconnectAccount,
  listConnectedAccounts,
  listRecentPosts,
  publishPost,
} from "../../modules/social/social.service.js";
import { MissingTokenKeyError } from "../../lib/tokenCrypto.js";
import { signedMediaUrl } from "../../lib/signedMedia.js";
import {
  cancelScheduledPost,
  listScheduledPosts,
  schedulePost,
  SchedulingError,
} from "../../modules/social/scheduler.service.js";
import { logger } from "../../lib/logger.js";
import { commandTrigger } from "./trigger.js";

/** Carried on a SOCIAL_POST approval so the approved action knows what to publish. */
export interface SocialPostPayload extends ApprovalPayload {
  platform: "INSTAGRAM";
  caption: string;
  mediaUrl?: string;
  assetId?: string;
  /** ISO timestamp. Present means approving queues it rather than posting now. */
  scheduledFor?: string;
}

export function registerSocialCommands(bot: Telegraf) {
  // The ONLY path to a real post. The agent can raise a card but never reaches
  // publishPost itself, so nothing publishes without this button press.
  registerApprovalAction("SOCIAL_POST", async (approval) => {
    const payload = approval.payload as unknown as SocialPostPayload;
    const caption = payload.fields?.["Caption"] ?? payload.caption;

    // Approving a scheduled post authorises a future publish rather than an
    // immediate one; the queue runner does the posting when its time comes.
    if (payload.scheduledFor) {
      let post;
      try {
        post = await schedulePost({
          platform: payload.platform,
          caption,
          assetId: payload.assetId,
          scheduledFor: new Date(payload.scheduledFor),
        });
      } catch (error) {
        // A card can sit unanswered past its own slot — approving it then
        // shouldn't post something whose moment has gone.
        if (error instanceof SchedulingError) {
          return `I didn't schedule that — ${error.message} Ask me again with a new time.`;
        }
        throw error;
      }
      return (
        `Scheduled for ${formatWhen(post.scheduledFor)}.\n\n` +
        `It goes out on its own then — nothing else needed from you. ` +
        `See it with /scheduled, or cancel with /cancel ${post.id}.`
      );
    }

    // Mint the media link now, not when the card was raised: a card can sit
    // unanswered for days, by which point the link signed back then has expired
    // and Instagram would fail to fetch the image.
    const mediaUrl = payload.assetId ? signedMediaUrl(payload.assetId) : payload.mediaUrl;

    const post = await publishPost({
      platform: payload.platform,
      caption,
      mediaUrl,
      assetId: payload.assetId,
    });

    if (post.dryRun) {
      return (
        `DRY RUN — nothing was actually posted to ${payload.platform}.\n\n` +
        `Recorded as post ${post.id}. Set DRY_RUN=false in Railway when you're ready to go live.`
      );
    }
    return `Posted to ${payload.platform}. Post id ${post.platformPostId}.`;
  });

  bot.command(commandTrigger("connect"), async (ctx) => {
    const parts = ctx.payload.trim().split(/\s+/).filter(Boolean);

    if (parts.length < 2) {
      await ctx.reply(
        "Usage: /connect <instagram-business-account-id> <access-token> [username]\n\n" +
          "You get both from the Meta developer console — see SOCIAL_SETUP.md for the walkthrough. " +
          "Send this in a direct message only, then delete the message: it contains a token that can post as you.",
      );
      return;
    }

    const [platformAccountId, accessToken, username] = parts;

    // The token is sitting in Telegram's history on both devices. Telegram lets a
    // bot delete incoming messages in a private chat, so get rid of it rather
    // than trusting Asher to remember.
    let tokenMessageRemoved = false;
    try {
      await ctx.deleteMessage();
      tokenMessageRemoved = true;
    } catch (error) {
      logger.warn("social.connect_message_not_deleted", { error: String(error) });
    }

    try {
      const account = await connectAccount({
        platform: "INSTAGRAM",
        platformAccountId: platformAccountId!,
        accessToken: accessToken!,
        username,
      });
      await ctx.reply(
        `Instagram account connected (${account.username ?? account.platformAccountId}).\n\n` +
          `DRY_RUN is currently ${env.DRY_RUN ? "ON — I'll show you exactly what would post without posting it" : "OFF — approved posts will go live for real"}.\n\n` +
          (tokenMessageRemoved
            ? "I've deleted your /connect message so the token isn't sitting in this chat."
            : "I couldn't delete your /connect message — delete it yourself, it still has the token in it."),
      );
    } catch (error) {
      if (error instanceof MissingTokenKeyError) {
        await ctx.reply(error.message);
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      logger.error("social.connect_failed", { error: detail });
      await ctx.reply(`Couldn't connect that account:\n\n${detail.slice(0, 300)}`);
    }
  });

  bot.command(commandTrigger("scheduled"), async (ctx) => {
    const posts = await listScheduledPosts();
    if (posts.length === 0) {
      await ctx.reply("Nothing scheduled. Ask me to post something at a particular time and I'll queue it up.");
      return;
    }

    const lines = ["SCHEDULED POSTS", ""];
    for (const post of posts) {
      lines.push(
        `• ${formatWhen(post.scheduledFor)} — ${post.socialAccount.platform}`,
        `  ${post.caption.slice(0, 90)}${post.caption.length > 90 ? "…" : ""}`,
        `  cancel: /cancel ${post.id}`,
        "",
      );
    }
    lines.push(env.DRY_RUN ? "DRY_RUN is ON — these won't post for real." : "DRY_RUN is OFF — these will go live.");
    await ctx.reply(lines.join("\n").slice(0, 4000));
  });

  bot.command(commandTrigger("cancel"), async (ctx) => {
    const id = ctx.payload.trim();
    if (!id) {
      await ctx.reply("Usage: /cancel <post-id>\n\nRun /scheduled to see the ids.");
      return;
    }
    const cancelled = await cancelScheduledPost(id);
    await ctx.reply(
      cancelled
        ? "Cancelled — that one won't go out."
        : "I couldn't cancel that. Either the id is wrong, or it has already posted. Check /scheduled.",
    );
  });

  bot.command(commandTrigger("disconnect"), async (ctx) => {
    const count = await disconnectAccount("INSTAGRAM");
    await ctx.reply(
      count > 0
        ? "Instagram disconnected. I can't post anywhere until you reconnect."
        : "There was no active Instagram account to disconnect.",
    );
  });

  bot.command(commandTrigger("accounts"), async (ctx) => {
    const accounts = await listConnectedAccounts();
    const lines = ["CONNECTED ACCOUNTS", ""];

    if (accounts.length === 0) {
      lines.push("Nothing connected — I can't post anywhere yet.", "", "Use /connect to link Instagram.");
    } else {
      for (const account of accounts) {
        const expiry = account.tokenExpiresAt ? ` — token expires ${account.tokenExpiresAt.toDateString()}` : "";
        lines.push(`• ${account.platform}: ${account.username ?? account.platformAccountId}${expiry}`);
      }
    }

    lines.push("", env.DRY_RUN ? "DRY_RUN is ON — nothing posts for real." : "DRY_RUN is OFF — approved posts go live.");

    const posts = await listRecentPosts(5);
    if (posts.length > 0) {
      lines.push("", "Recent posts:");
      for (const post of posts) {
        const marker = post.dryRun ? " (dry run)" : "";
        const detail = post.status === "FAILED" ? ` — ${post.failureReason ?? "failed"}` : "";
        lines.push(`• ${post.socialAccount.platform} ${post.status}${marker}: ${post.caption.slice(0, 60)}${detail}`);
      }
    }

    await ctx.reply(lines.join("\n").slice(0, 4000));
  });
}

/** Renders a scheduled time in Asher's own timezone, not UTC. */
function formatWhen(when: Date | null): string {
  if (!when) return "an unknown time";
  return when.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
