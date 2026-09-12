import type { Telegraf } from "telegraf";
import { env } from "../../config/env.js";
import {
  authorisationUrl,
  disconnect,
  getConnection,
  GoogleNotConfiguredError,
  GoogleNotConnectedError,
} from "../../modules/oauth/google.service.js";
import { listVideos, formatVideoList, DriveError } from "../../modules/drive/drive.service.js";
import { logger } from "../../lib/logger.js";
import { commandTrigger } from "./trigger.js";

export function registerDriveCommands(bot: Telegraf) {
  bot.command(commandTrigger("drive"), async (ctx) => {
    const connection = await getConnection();

    if (connection) {
      await ctx.reply(
        [
          "GOOGLE DRIVE",
          "",
          `Connected${connection.accountEmail ? ` as ${connection.accountEmail}` : ""}.`,
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
          "Open this link and approve access — it's read-only, so I can look at your videos but never change or delete anything:",
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
      if (error instanceof GoogleNotConnectedError || error instanceof GoogleNotConfiguredError) {
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
