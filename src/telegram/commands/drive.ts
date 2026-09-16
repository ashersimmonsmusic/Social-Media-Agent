import type { Telegraf } from "telegraf";
import { env } from "../../config/env.js";
import {
  authorisationUrl,
  disconnect,
  getConnection,
  GoogleNotConfiguredError,
  GoogleNotConnectedError,
  GoogleReauthRequiredError,
} from "../../modules/oauth/google.service.js";
import { listVideos, formatVideoList, DriveError } from "../../modules/drive/drive.service.js";
import { isServiceAccountConfigured, serviceAccountEmail } from "../../modules/oauth/serviceAccount.js";
import { prepareVideoForReels, formatPreparedVideo } from "../../modules/video/video.service.js";
import { VideoToolError } from "../../modules/video/ffmpeg.js";
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
        [
          "Usage: /reel <video-id> [crop|blur] [start-seconds]",
          "",
          "Get the id from /videos. I'll make a vertical 9:16 cut and send it back for you to watch.",
          "",
          "Leave the mode off and I'll look at the footage and decide: crop in on the subject if it stays put, ",
          "or keep the whole frame with a blurred fill if it doesn't. Add crop or blur to force one.",
        ].join("\n"),
      );
      return;
    }

    const mode: ReframeMode = parts.includes("crop") ? "crop" : parts.includes("blur") ? "blur" : "auto";
    const startArg = parts.slice(1).find((part) => /^\d+$/.test(part));

    await ctx.reply("Working on it — reading the footage, deciding the framing, then rendering. Usually a minute or two.");

    try {
      await ctx.sendChatAction("upload_video");
      const prepared = await prepareVideoForReels({
        driveFileId: fileId,
        mode,
        startSeconds: startArg ? Number(startArg) : undefined,
      });

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
        error instanceof VideoToolError || error instanceof DriveError
          ? detail
          : `Couldn't make that into a Reel:\n\n${detail.slice(0, 400)}`,
      );
    }
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
      const videos = await listVideos(15);
      await ctx.reply(`YOUR VIDEOS\n\n${formatVideoList(videos)}`.slice(0, 4000));
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
