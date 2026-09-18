import type { Context, Telegraf } from "telegraf";
import { env } from "../../config/env.js";
import {
  DriveError,
  listTracks,
  type DriveTrack,
} from "../../modules/drive/drive.service.js";
import {
  GoogleNotConfiguredError,
  GoogleNotConnectedError,
  GoogleReauthRequiredError,
} from "../../modules/oauth/google.service.js";
import {
  chooseTrack,
  clampGain,
  DEFAULT_GAIN_DB,
  forgetBed,
  formatBed,
  getBed,
  MusicError,
  trackTitle,
  updateBed,
} from "../../modules/music/music.service.js";
import { isServiceAccountConfigured, serviceAccountEmail } from "../../modules/oauth/serviceAccount.js";
import { logger } from "../../lib/logger.js";
import { commandTrigger } from "./trigger.js";

/**
 * Choosing music to sit under every clip the bot renders.
 *
 * Worth being clear about what this is not: Instagram's publishing API cannot
 * reach the app's music catalogue, so there is no way for the bot to put a
 * trending sound on a post. What it can do is mix a track into the file before
 * it uploads — which for Asher's own music is the better answer anyway.
 */

const HELP = [
  "MUSIC",
  "",
  "/music — see the tracks in your Drive and pick one",
  "/music on — start putting it under every clip again",
  "/music off — stop, but remember the track",
  "/music level -10 — how loud it sits (0 is loudest, -40 barely there)",
  "/music start 32 — begin 32 seconds into the track instead of the top",
  "/music forget — clear it entirely",
  "",
  "Whatever's set gets mixed in when I render a clip, and pulled down automatically",
  "while you're talking. One clip without it: /reel <id> nomusic.",
].join("\n");

export function registerMusicCommands(bot: Telegraf) {
  bot.command(commandTrigger("music"), async (ctx) => {
    const parts = ctx.payload.trim().split(/\s+/).filter(Boolean);
    const [word, value] = [parts[0]?.toLowerCase(), parts[1]];

    try {
      switch (word) {
        case undefined:
          await showTracks(ctx);
          return;

        case "help":
          await ctx.reply(HELP);
          return;

        case "on":
        case "off": {
          const bed = await updateBed({ enabled: word === "on" });
          await ctx.reply(
            word === "on"
              ? `Music back on.\n\n${formatBed(bed)}`
              : `Music off. I'll keep ${trackTitle(bed.name)} in mind — /music on brings it back.`,
          );
          return;
        }

        case "level": {
          const parsed = Number(value);
          if (!Number.isFinite(parsed)) {
            await ctx.reply(
              `Give me a number in decibels, like /music level -10. ` +
                `${DEFAULT_GAIN_DB} is the default — lower is quieter, 0 is as loud as the file itself.`,
            );
            return;
          }
          const bed = await updateBed({ gainDb: parsed });
          const clamped = clampGain(parsed);
          await ctx.reply(
            (clamped !== Math.round(parsed * 10) / 10
              ? `${parsed}dB is outside what's useful, so I've used ${clamped}dB.\n\n`
              : "") +
              formatBed(bed) +
              "\n\nRender a clip to hear it. Tell me again if it's not sitting right.",
          );
          return;
        }

        case "start": {
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed < 0) {
            await ctx.reply("Give me a number of seconds, like /music start 32. Use /music start 0 for the top.");
            return;
          }
          const bed = await updateBed({ startSeconds: parsed });
          await ctx.reply(formatBed(bed));
          return;
        }

        case "forget": {
          const had = await forgetBed();
          await ctx.reply(
            had
              ? "Forgotten. Nothing gets music until you pick a track again."
              : "There wasn't one set, so nothing to forget.",
          );
          return;
        }

        default:
          await ctx.reply(`I don't know "${word}".\n\n${HELP}`);
          return;
      }
    } catch (error) {
      if (error instanceof MusicError) {
        await ctx.reply(error.message);
        return;
      }
      throw error;
    }
  });
}

/** Where the tracks are expected to be, said in terms of what to do about it. */
function noTracksAdvice(): string {
  const scoped = Boolean(env.GOOGLE_DRIVE_MUSIC_FOLDER_ID);
  const lines = [
    "I can't see any music.",
    "",
    scoped
      ? "I'm looking at the music folder you pointed me at. Drop an MP3, M4A or WAV in there."
      : "Put your tracks in a folder in Drive and set GOOGLE_DRIVE_MUSIC_FOLDER_ID in Railway to that folder's id — " +
        "the long code in its address bar. Until then I look wherever I look for video.",
  ];

  if (isServiceAccountConfigured()) {
    const email = serviceAccountEmail();
    lines.push(
      "",
      email
        ? `The folder also has to be shared with:\n${email}`
        : "Check GOOGLE_SERVICE_ACCOUNT_JSON in Railway — I couldn't read the address to share with.",
    );
  }

  return lines.join("\n");
}

async function showTracks(ctx: Context): Promise<void> {
  const bed = await getBed();

  try {
    await ctx.sendChatAction("typing");
    const tracks = await listTracks(12);

    if (tracks.length === 0) {
      await ctx.reply(`${formatBed(bed)}\n\n${noTracksAdvice()}`);
      return;
    }

    await ctx.reply(`${formatBed(bed)}\n\nTap a track to use it under everything I render.`, {
      reply_markup: {
        inline_keyboard: tracks.map((track: DriveTrack) => [
          {
            // Marked so the current one is obvious without reading back up.
            text: `${track.id === bed?.driveFileId ? "● " : ""}${trackLabel(track)}`,
            callback_data: `bed:${track.id}`,
          },
        ]),
      },
    });
  } catch (error) {
    await replyWithTrackError(ctx, error);
  }
}

/** Drive reports no duration for audio, so the label carries the size instead. */
export function trackLabel(track: DriveTrack): string {
  const title = trackTitle(track.name);
  const trimmed = title.length > 30 ? `${title.slice(0, 29)}…` : title;
  return `${trimmed} · ${(track.sizeBytes / 1024 / 1024).toFixed(1)}MB`;
}

export function registerMusicCallbacks(bot: Telegraf) {
  bot.on("callback_query", async (ctx, next) => {
    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!data || !data.startsWith("bed:")) return next();

    await ctx.answerCbQuery("Setting it…");
    // The list has done its job; leaving it live invites a second tap that looks
    // like nothing happened.
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});

    try {
      const bed = await chooseTrack(data.slice("bed:".length));
      await ctx.reply(
        `${formatBed(bed)}\n\n` +
          `Next clip I render gets it. If it's too loud or too quiet, /music level -10 and so on — ` +
          `you'll only need to find that number once.`,
      );
    } catch (error) {
      if (error instanceof MusicError) {
        await ctx.reply(error.message);
        return;
      }
      await replyWithTrackError(ctx, error);
    }
  });
}

async function replyWithTrackError(ctx: Context, error: unknown): Promise<void> {
  if (
    error instanceof GoogleNotConnectedError ||
    error instanceof GoogleNotConfiguredError ||
    error instanceof GoogleReauthRequiredError
  ) {
    await ctx.reply(error.message);
    return;
  }
  const detail = error instanceof Error ? error.message : String(error);
  logger.error("music.list_failed", { error: detail });
  await ctx.reply(
    error instanceof DriveError ? detail : `Couldn't read your music from Drive:\n\n${detail.slice(0, 300)}`,
  );
}
