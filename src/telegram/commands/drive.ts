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
  renameFile,
  getVideo,
  DriveError,
  type DriveVideo,
} from "../../modules/drive/drive.service.js";
import { isServiceAccountConfigured, serviceAccountEmail } from "../../modules/oauth/serviceAccount.js";
import { prepareVideoForReels, formatPreparedVideo } from "../../modules/video/video.service.js";
import { VideoToolError } from "../../modules/video/ffmpeg.js";
import type { ReframeMode } from "../../modules/video/reframe.service.js";
import { sendVideoPreview } from "../notify.js";
import { setAwaitingRename, takeAwaitingRename } from "../editState.js";
import { suggestName, NamingError } from "../../modules/drive/naming.service.js";
import {
  applyBatchRename,
  formatPlan,
  planBatchRename,
  undoLastBatchRename,
  type RenamePlanEntry,
} from "../../modules/drive/batchRename.service.js";
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
          "Add `subs` to burn what's spoken onto the picture: /reel <id> subs",
      );
      return;
    }

    const mode: ReframeMode = parts.includes("crop") ? "crop" : parts.includes("blur") ? "blur" : "auto";
    const startArg = parts.slice(1).find((part) => /^\d+$/.test(part));
    const subtitles = parts.includes("subs") || parts.includes("subtitles");
    await makeReel(ctx, fileId, mode, startArg ? Number(startArg) : undefined, subtitles);
  });

  bot.command(commandTrigger("rename"), async (ctx) => {
    const payload = ctx.payload.trim();

    if (/^undo$/i.test(payload)) {
      await ctx.sendChatAction("typing");
      const result = await undoLastBatchRename();
      await ctx.reply(
        !result
          ? "I haven't done a batch rename to undo."
          : result.failed > 0
            ? `Put ${result.restored} back. ${result.failed} wouldn't revert — check them in Drive.`
            : `Put all ${result.restored} back to what they were called.`,
      );
      return;
    }

    if (/^all(\s+deep)?$/i.test(payload)) {
      const deep = /deep/i.test(payload);
      await ctx.reply(
        deep
          ? "Going through them properly — I'll download the ones nothing has read. This takes a few minutes."
          : "Having a look at what I can name…",
      );

      try {
        await ctx.sendChatAction("typing");
        const plan = await planBatchRename(deep);

        if (plan.entries.length === 0) {
          await ctx.reply(formatPlan(plan));
          return;
        }

        // The whole list first. Renaming fifteen files is the largest change
        // the bot can make to his Drive and it should never be a surprise.
        pendingPlans.set(String(ctx.chat?.id ?? ""), plan.entries);
        await ctx.reply(formatPlan(plan).slice(0, 3800), {
          reply_markup: {
            inline_keyboard: [
              [{ text: `Rename all ${plan.entries.length}`, callback_data: "rnb:apply" }],
              [{ text: "Leave them", callback_data: "rnb:cancel" }],
            ],
          },
        });
      } catch (error) {
        await replyWithDriveError(ctx, error, "rename.batch_failed");
      }
      return;
    }

    // "/rename <id> <name>" in one go, for when he already has the id.
    const direct = /^(\S+)\s+(.+)$/.exec(payload);
    if (direct) {
      const [, fileId, newName] = direct;
      await applyRename(ctx, fileId!, newName!);
      return;
    }

    try {
      await ctx.sendChatAction("typing");
      const videos = await listVideos(12);
      if (videos.length === 0) {
        await ctx.reply(formatVideoList(videos));
        return;
      }

      // A list to tap, for the same reason /videos has one: transcribing a
      // 33-character Drive id from one message into another is where this
      // stops being used.
      await ctx.reply("Which one should I rename?\n\n/rename all — do the whole folder · /rename undo — put it back", {
        reply_markup: {
          inline_keyboard: videos.map((video: DriveVideo) => [
            { text: videoButtonLabel(video), callback_data: `rn:${video.id}` },
          ]),
        },
      });
    } catch (error) {
      await replyWithDriveError(ctx, error, "rename.list_failed");
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
): Promise<void> {
  await ctx.reply("Working on it — reading the footage, deciding the framing, then rendering. Usually a minute or two.");

  try {
    await ctx.sendChatAction("upload_video");
    const prepared = await prepareVideoForReels({ driveFileId: fileId, mode, startSeconds, subtitles });

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

/** Renames one file and says what changed, since a silent rename is unnerving. */
export async function applyRename(ctx: Context, fileId: string, newName: string): Promise<void> {
  try {
    const { from, to } = await renameFile(fileId, newName);
    await ctx.reply(
      from === to ? `It was already called "${to}".` : `Renamed:\n\n${from}\n  ↓\n${to}`,
    );
  } catch (error) {
    await replyWithDriveError(ctx, error, "rename.failed");
  }
}

/** Handles a tap on the rename list: remembers the file, then waits for a name. */
export function registerRenameCallbacks(bot: Telegraf) {
  bot.on("callback_query", async (ctx, next) => {
    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!data || !data.startsWith("rn:")) return next();

    const fileId = data.slice("rn:".length);
    const chatId = String(ctx.chat?.id ?? "");
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});

    let currentName = fileId;
    try {
      currentName = (await getVideo(fileId)).name;
    } catch {
      // Not worth failing the rename over; the name is only for the prompt.
    }

    setAwaitingRename(chatId, fileId, currentName);
    await ctx.reply(
      [
        `Currently "${currentName}".`,
        "",
        "Send me a name, or let me work one out from the footage.",
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [[{ text: "Suggest a name", callback_data: `rns:${fileId}` }]],
        },
      },
    );
  });

  // Working out a name, then offering it rather than applying it. Renaming is
  // the one change the bot can make to his Drive, and it should stay something
  // he agreed to rather than something that happened.
  bot.on("callback_query", async (ctx, next) => {
    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!data || !data.startsWith("rns:")) return next();

    const fileId = data.slice("rns:".length);
    await ctx.answerCbQuery("Having a look…");
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});

    try {
      await ctx.sendChatAction("typing");
      const suggestion = await suggestName(fileId);
      if (!suggestion) {
        await ctx.reply("I couldn't tell what that one is from looking at it. What would you call it?");
        return;
      }

      // Kept pending, so typing something else still works as an override.
      setAwaitingRename(String(ctx.chat?.id ?? ""), fileId, suggestion.name);
      await ctx.reply(
        [
          `How about:`,
          "",
          suggestion.name,
          "",
          suggestion.basis === "transcript"
            ? "(from what's said in it)"
            : "(from a few frames — I haven't heard it)",
          "",
          "Tap to use it, or just send me a different name.",
        ].join("\n"),
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "Use this name", callback_data: `rnu:${fileId}` }],
            ],
          },
        },
      );
    } catch (error) {
      await ctx.reply(
        error instanceof NamingError ? error.message : `I couldn't work out a name: ${String(error)}`,
      );
    }
  });

  bot.on("callback_query", async (ctx, next) => {
    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!data || !data.startsWith("rnu:")) return next();

    const fileId = data.slice("rnu:".length);
    const pending = takeAwaitingRename(String(ctx.chat?.id ?? ""));
    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});

    if (!pending || pending.fileId !== fileId) {
      await ctx.reply("That suggestion has gone — send /rename to start again.");
      return;
    }
    await applyRename(ctx, fileId, pending.currentName);
  });
}

/**
 * The batch each chat has been shown but not yet agreed to.
 *
 * Held in memory like the other pending-reply state: if the process restarts
 * before he taps, nothing has happened to his Drive and he runs the command
 * again. Persisting a proposal would be more machinery than the risk warrants.
 */
const pendingPlans = new Map<string, RenamePlanEntry[]>();

/** Handles agreeing to, or walking away from, a proposed batch. */
export function registerBatchRenameCallbacks(bot: Telegraf) {
  bot.on("callback_query", async (ctx, next) => {
    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!data || !data.startsWith("rnb:")) return next();

    const chatId = String(ctx.chat?.id ?? "");
    const entries = pendingPlans.get(chatId);
    pendingPlans.delete(chatId);
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});

    if (data === "rnb:cancel") {
      await ctx.answerCbQuery("Left alone");
      await ctx.reply("Left them as they are.");
      return;
    }

    if (!entries || entries.length === 0) {
      await ctx.answerCbQuery();
      await ctx.reply("That plan has gone — send /rename all again.");
      return;
    }

    await ctx.answerCbQuery("Renaming…");
    const result = await applyBatchRename(entries);

    await ctx.reply(
      [
        result.renamed.length > 0 ? `Renamed ${result.renamed.length}.` : "Nothing renamed.",
        ...(result.failed.length > 0
          ? ["", "Wouldn't rename:", ...result.failed.map((failure) => `• ${failure.from} — ${failure.reason}`)]
          : []),
        "",
        "/rename undo puts them all back if you don't like them.",
      ].join("\n"),
    );
  });
}
