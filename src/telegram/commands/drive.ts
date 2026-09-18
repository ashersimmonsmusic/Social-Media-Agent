import type { Context, Telegraf } from "telegraf";
import { env } from "../../config/env.js";
import {
  authorisationUrl,
  disconnect,
  getConnection,
  GoogleNotConfiguredError,
  GoogleNotConnectedError,
  GoogleReauthRequiredError,
} from "../../modules/oauth/google.service.js";
import {
  listVideos,
  formatVideoList,
  videoButtonLabel,
  getVideo,
  DriveError,
  type DriveVideo,
} from "../../modules/drive/drive.service.js";
import { isServiceAccountConfigured, serviceAccountEmail } from "../../modules/oauth/serviceAccount.js";
import { prepareVideoForReels, formatPreparedVideo } from "../../modules/video/video.service.js";
import { VideoToolError } from "../../modules/video/ffmpeg.js";
import { MusicError } from "../../modules/music/music.service.js";
import type { ReframeMode } from "../../modules/video/reframe.service.js";
import { sendVideoPreview } from "../notify.js";
import { storage } from "../../storage/index.js";
import { getAsset } from "../../modules/assets/asset.service.js";
import { logger } from "../../lib/logger.js";
import { commandTrigger } from "./trigger.js";

export function registerDriveCommands(bot: Telegraf) {
  bot.command(commandTrigger("drive"), async (ctx) => {
    // A service account replaces the consent flow entirely, so none of the
    // connect/disconnect wording below applies when one is configured.
    if (isServiceAccountConfigured()) {
      const email = serviceAccountEmail();
      await ctx.reply(
        [
          "GOOGLE DRIVE",
          "",
          "Connected through a service account. Nothing to re-approve — this doesn't expire.",
          "",
          email
            ? `I can see anything shared with:\n${email}`
            : "I couldn't read the address from GOOGLE_SERVICE_ACCOUNT_JSON — check it's the complete key file.",
          "",
          env.GOOGLE_DRIVE_FOLDER_ID
            ? "Share a folder with that address and I'll read the one you've pointed me at."
            : "Open your folder in Drive → Share → add that address as a Viewer.",
          "",
          "Then /videos to see what's there.",
        ].join("\n"),
      );
      return;
    }

    const connection = await getConnection();

    if (connection) {
      await ctx.reply(
        [
          "GOOGLE DRIVE",
          "",
          `Connected${connection.accountEmail ? ` as ${connection.accountEmail}` : ""}.`,
          "",
          "Note: Google expires this every 7 days while your Google app is set to \"Testing\", and I'll tell you " +
            "when it does. A service account removes that for good — see DRIVE_SETUP.md.",
          env.GOOGLE_DRIVE_FOLDER_ID
            ? "I'm only looking at the one folder you pointed me at."
            : "I can see videos across your whole Drive. Set GOOGLE_DRIVE_FOLDER_ID in Railway to narrow that to one folder.",
          "",
          "Use /videos to see what's there. Disconnect any time with /drivedisconnect.",
        ].join("\n"),
      );
      return;
    }

    try {
      await ctx.reply(
        [
          "Google Drive isn't connected yet.",
          "",
          "Open this link and approve access — it's read-only, so I can look at your videos but never change or delete anything.",
          "",
          "Google will warn you it hasn't verified the app. That's expected — it's yours. Advanced → Go to the app.",
          "",
          "",
          authorisationUrl(),
          "",
          "The link expires in 10 minutes.",
        ].join("\n"),
      );
    } catch (error) {
      if (error instanceof GoogleNotConfiguredError) {
        await ctx.reply(error.message);
        return;
      }
      throw error;
    }
  });

  bot.command(commandTrigger("reel"), async (ctx) => {
    const parts = ctx.payload.trim().split(/\s+/).filter(Boolean);
    const fileId = parts[0];

    if (!fileId) {
      await ctx.reply(
        "Send /videos and tap the clip you want — no need to type an id.\n\n" +
          "Add `subs` to burn what's spoken onto the picture: /reel <id> subs\n" +
          "Add `nomusic` to skip the music bed just this once: /reel <id> nomusic",
      );
      return;
    }

    const mode: ReframeMode = parts.includes("crop") ? "crop" : parts.includes("blur") ? "blur" : "auto";
    const startArg = parts.slice(1).find((part) => /^\d+$/.test(part));
    const subtitles = parts.includes("subs") || parts.includes("subtitles");
    // Undefined rather than true when unasked: whether there is a bed at all is
    // /music's business, and passing true here would override its off switch.
    const music = parts.includes("nomusic") || parts.includes("nobed") ? false : undefined;
    await makeReel(ctx, fileId, mode, startArg ? Number(startArg) : undefined, subtitles, music);
  });

  bot.command(commandTrigger("drivedisconnect"), async (ctx) => {
    const wasConnected = await disconnect();
    await ctx.reply(
      wasConnected
        ? "Disconnected. I can't see your Drive any more. Revoke it fully at myaccount.google.com/permissions if you want it gone from Google's side too."
        : "Google Drive wasn't connected.",
    );
  });

  bot.command(commandTrigger("videos"), async (ctx) => {
    try {
      await ctx.sendChatAction("typing");
      const videos = await listVideos(12);

      if (videos.length === 0) {
        await ctx.reply(formatVideoList(videos));
        return;
      }

      // One button per clip rather than an id to copy: on a phone, transcribing
      // a 33-character Drive id from a message into a command is the step where
      // this stops being used.
      await ctx.reply("YOUR VIDEOS\n\nTap one and I'll make it vertical.", {
        reply_markup: {
          inline_keyboard: videos.map((video: DriveVideo) => [
            { text: videoButtonLabel(video), callback_data: `reel:${video.id}` },
          ]),
        },
      });
    } catch (error) {
      if (
        error instanceof GoogleNotConnectedError ||
        error instanceof GoogleNotConfiguredError ||
        error instanceof GoogleReauthRequiredError
      ) {
        await ctx.reply(error.message);
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      logger.error("drive.list_failed", { error: detail });
      await ctx.reply(
        error instanceof DriveError ? detail : `Couldn't read your Drive:\n\n${detail.slice(0, 300)}`,
      );
    }
  });
}

/**
 * Prepares one clip and reports back. Shared by the /reel command and the
 * buttons on /videos, so the two cannot drift into behaving differently.
 */
async function makeReel(
  ctx: Context,
  fileId: string,
  mode: ReframeMode = "auto",
  startSeconds?: number,
  subtitles = false,
  music?: boolean,
): Promise<void> {
  await ctx.reply("Working on it — reading the footage, deciding the framing, then rendering. Usually a minute or two.");

  try {
    await ctx.sendChatAction("upload_video");
    const prepared = await prepareVideoForReels({ driveFileId: fileId, mode, startSeconds, subtitles, music });

    const asset = await getAsset(prepared.assetId);
    const sent = asset?.storageKey
      ? await sendVideoPreview(ctx.telegram, {
          data: await storage.read(asset.storageKey),
          filename: prepared.filename,
          caption: prepared.reason,
        })
      : false;

    await ctx.reply(
      formatPreparedVideo(prepared) +
        (sent
          ? "\n\nAsk me for a caption when you've watched it."
          : "\n\nThe clip is too big to send here, so you haven't seen it yet — it's in your library either way."),
    );
  } catch (error) {
    if (
      error instanceof GoogleNotConnectedError ||
      error instanceof GoogleNotConfiguredError ||
      error instanceof GoogleReauthRequiredError
    ) {
      await ctx.reply(error.message);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    logger.error("reel.prepare_failed", { fileId, error: detail });
    await ctx.reply(
      error instanceof VideoToolError || error instanceof DriveError || error instanceof MusicError
        ? detail
        : `Couldn't make that into a Reel:\n\n${detail.slice(0, 400)}`,
    );
  }
}

/** Handles a tap on one of the clips listed by /videos. */
export function registerDriveCallbacks(bot: Telegraf) {
  bot.on("callback_query", async (ctx, next) => {
    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!data || !data.startsWith("reel:")) return next();

    const fileId = data.slice("reel:".length);
    // Answered immediately: Telegram shows a spinner on the button until it is,
    // and rendering takes minutes.
    await ctx.answerCbQuery("Starting…");
    // The list has served its purpose, and leaving live buttons invites a second
    // render of the same clip while the first is still going.
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});

    await makeReel(ctx, fileId);
  });
}

/** One place for the "Drive isn't reachable" replies, which several paths share. */
async function replyWithDriveError(ctx: Context, error: unknown, logKey: string): Promise<void> {
  if (
    error instanceof GoogleNotConnectedError ||
    error instanceof GoogleNotConfiguredError ||
    error instanceof GoogleReauthRequiredError
  ) {
    await ctx.reply(error.message);
    return;
  }
  const detail = error instanceof Error ? error.message : String(error);
  logger.error(logKey, { error: detail });
  await ctx.reply(error instanceof DriveError ? detail : `Couldn't reach your Drive:\n\n${detail.slice(0, 300)}`);
}
