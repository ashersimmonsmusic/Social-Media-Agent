import type { Context, Telegraf } from "telegraf";
import { prisma } from "../../db/prisma.js";
import { storage } from "../../storage/index.js";
import { logger } from "../../lib/logger.js";
import { getAsset } from "../../modules/assets/asset.service.js";
import { applyOfferedRename, queueVideo, runNextClippingJob } from "../../modules/clipping/job.service.js";
import {
  decideClip,
  formatClip,
  latestAnalysedVideo,
  listClips,
  selectTop,
  selectionSummary,
  type SortBy,
} from "../../modules/clipping/review.service.js";
import { captionsForClip, readyToPublish, ClipNotReadyError } from "../../modules/clipping/publish.service.js";
import { sendVideoPreview } from "../notify.js";
import { commandTrigger } from "./trigger.js";

/** Long enough that he isn't scrolling past clips to reach the buttons. */
const CLIPS_PER_MESSAGE = 6;

function progressLine(status: string, detail: string | null): string {
  const words: Record<string, string> = {
    QUEUED: "Waiting to start",
    DOWNLOADING: "Fetching the video",
    EXTRACTING_AUDIO: "Pulling the audio out",
    TRANSCRIBING: "Transcribing",
    ANALYSING: "Reading it through",
    CUTTING: "Cutting the clips",
    COMPLETE: "Done",
    FAILED: "Failed",
  };
  return detail ? `${words[status] ?? status} — ${detail}` : (words[status] ?? status);
}

export function registerClipCommands(bot: Telegraf) {
  bot.command(commandTrigger("analyse", "analyze"), async (ctx) => {
    const fileId = ctx.payload.trim().split(/\s+/)[0];
    if (!fileId) {
      await ctx.reply(
        [
          "Send /videos, tap a clip's row, or give me a Drive id:",
          "",
          "/analyse <video-id>",
          "",
          "I'll read the whole thing, find the moments worth cutting, rank them, and cut the best few. " +
            "A long video takes a while — I'll message you when it's done.",
        ].join("\n"),
      );
      return;
    }

    try {
      const { filename, queued } = await queueVideo(fileId);
      await ctx.reply(
        queued
          ? `Queued ${filename}. I'll read it through and message you when there's something to look at — ` +
              `an hour of footage takes a while. /clips status to check on it.`
          : `I've already got ${filename}. /clips to see what I found, or /clips retry to go through it again.`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error("clips.queue_failed", { error: detail });
      await ctx.reply(`I couldn't queue that: ${detail}`);
    }
  });

  bot.command(commandTrigger("clips"), async (ctx) => {
    const parts = ctx.payload.trim().split(/\s+/).filter(Boolean);
    const [first, second] = parts;

    if (first === "status") return showStatus(ctx);
    if (first === "retry") return retryLatest(ctx);

    if (first === "select") {
      if (second === "top") {
        const count = Number(parts[2]) || 3;
        const selected = await selectTop(count);
        await ctx.reply(selected > 0 ? `Selected the top ${selected}.` : "Nothing to select yet.");
        return;
      }
      const ranks = parts.slice(1).map(Number).filter((rank) => Number.isFinite(rank));
      if (ranks.length === 0) {
        await ctx.reply("Which ones? /clips select 1 3 5 — or /clips select top 3");
        return;
      }
      const done: number[] = [];
      for (const rank of ranks) if (await decideClip(rank, "SELECTED")) done.push(rank);
      await ctx.reply(done.length > 0 ? `Selected ${done.join(", ")}.` : "I couldn't find those.");
      return;
    }

    if (first === "caption") {
      const rank = Number(second);
      if (!Number.isFinite(rank)) {
        await ctx.reply("Which one? /clips caption 1");
        return;
      }
      await ctx.sendChatAction("typing");
      try {
        const { title, rendered } = await captionsForClip(rank);
        if (rendered.length === 0) {
          await ctx.reply(`I couldn't draft anything usable for "${title}".`);
          return;
        }
        await ctx.reply(
          [`CAPTIONS FOR "${title}"`, "", ...rendered.map((text, index) => `${index + 1}.\n${text}`)].join(
            "\n\n———\n\n",
          ).slice(0, 4000),
        );
      } catch (error) {
        await ctx.reply(
          error instanceof ClipNotReadyError
            ? error.message
            : `I couldn't write captions for that: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }

    if (first === "selected") {
      const { ready, needCutting } = await readyToPublish();
      if (ready.length === 0 && needCutting.length === 0) {
        await ctx.reply("You haven't selected any yet. /clips to look through them.");
        return;
      }
      await ctx.reply(
        [
          "SELECTED CLIPS",
          "",
          ...ready.map((clip) => `${String(clip.rank).padStart(2, "0")} — ${clip.title} — ready to post`),
          ...needCutting.map(
            (clip) => `${String(clip.rank).padStart(2, "0")} — ${clip.title} — not cut yet, ask me and I'll render it`,
          ),
          "",
          "Ask me for a caption — 'caption clip 1' — then I'll put it in front of you to approve like any other post.",
        ].join("\n"),
      );
      return;
    }

    if (first === "reject") {
      const ranks = parts.slice(1).map(Number).filter((rank) => Number.isFinite(rank));
      const done: number[] = [];
      for (const rank of ranks) if (await decideClip(rank, "REJECTED")) done.push(rank);
      await ctx.reply(done.length > 0 ? `Rejected ${done.join(", ")}. I'll remember that.` : "I couldn't find those.");
      return;
    }

    const sortBy: SortBy = first === "duration" || first === "newest" || first === "topic" ? first : "score";
    await showClips(ctx, sortBy);
  });
}

async function showStatus(ctx: Context): Promise<void> {
  const inFlight = await prisma.sourceVideo.findMany({
    where: { status: { notIn: ["COMPLETE"] } },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  if (inFlight.length === 0) {
    await ctx.reply("Nothing being analysed. /analyse <video-id> to start one.");
    return;
  }

  await ctx.reply(
    [
      "ANALYSIS IN PROGRESS",
      "",
      ...inFlight.map((video) =>
        video.status === "FAILED"
          ? `${video.filename}\n  Failed — ${video.failureReason ?? "no reason recorded"}`
          : `${video.filename}\n  ${progressLine(video.status, video.statusDetail)}`,
      ),
    ].join("\n"),
  );
}

async function retryLatest(ctx: Context): Promise<void> {
  const video = await prisma.sourceVideo.findFirst({ orderBy: { createdAt: "desc" } });
  if (!video) {
    await ctx.reply("Nothing to retry.");
    return;
  }
  // The transcript is kept, so a retry re-reads rather than re-transcribes —
  // the only step that costs money is not paid for twice.
  await prisma.sourceVideo.update({
    where: { id: video.id },
    data: { status: "QUEUED", claimedAt: null, failureReason: null, statusDetail: null },
  });
  await ctx.reply(`Queued ${video.filename} again. I'll message you when it's done.`);
  void runNextClippingJob(ctx.telegram).catch((error) => logger.error("clips.retry_failed", { error: String(error) }));
}

async function showClips(ctx: Context, sortBy: SortBy): Promise<void> {
  const video = await latestAnalysedVideo();
  if (!video) {
    await ctx.reply("I haven't analysed anything yet. /analyse <video-id> to start.");
    return;
  }

  const clips = await listClips({ videoId: video.id, sortBy });
  if (clips.length === 0) {
    await ctx.reply(`Nothing left in ${video.filename} — everything's been rejected.`);
    return;
  }

  const summary = await selectionSummary(video.id);
  await ctx.reply(
    [
      `${video.filename.toUpperCase()}`,
      `${clips.length} clip${clips.length === 1 ? "" : "s"}, best first` + (sortBy !== "score" ? ` (by ${sortBy})` : ""),
      summary ? `${summary.selected} selected · ${summary.rejected} rejected · ${summary.pending} undecided` : "",
      "",
      "/clips select 1 3 · /clips reject 2 · /clips select top 3",
      "/clips caption 1 · /clips selected · sort: duration, topic, newest",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  for (const clip of clips.slice(0, CLIPS_PER_MESSAGE)) {
    const text = formatClip(clip);

    // The clip itself where it exists: a score and a transcript are not enough
    // to judge whether a moment plays.
    let sent = false;
    if (clip.assetId) {
      try {
        const asset = await getAsset(clip.assetId);
        if (asset?.storageKey) {
          sent = await sendVideoPreview(ctx.telegram, {
            data: await storage.read(asset.storageKey),
            filename: asset.filename,
            caption: text.slice(0, 1024),
          });
        }
      } catch (error) {
        logger.warn("clips.preview_failed", { clipId: clip.id, error: String(error) });
      }
    }

    if (!sent) {
      await ctx.reply(text, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: `✓ Select ${clip.rank}`, callback_data: `clip:sel:${clip.rank}` },
              { text: `✗ Reject ${clip.rank}`, callback_data: `clip:rej:${clip.rank}` },
            ],
          ],
        },
      });
    } else {
      await ctx.reply(`${String(clip.rank).padStart(2, "0")} — keep it?`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: `✓ Select ${clip.rank}`, callback_data: `clip:sel:${clip.rank}` },
              { text: `✗ Reject ${clip.rank}`, callback_data: `clip:rej:${clip.rank}` },
            ],
          ],
        },
      });
    }
  }
}

/** Handles "yes, rename it" from the message sent after an analysis. */
export function registerAnalysisRenameCallback(bot: Telegraf) {
  bot.on("callback_query", async (ctx, next) => {
    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!data || !data.startsWith("rna:")) return next();

    const driveFileId = data.slice("rna:".length);
    await ctx.answerCbQuery("Renaming…");
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});

    try {
      const result = await applyOfferedRename(driveFileId);
      await ctx.reply(
        result ? `Renamed:\n\n${result.from}\n  ↓\n${result.to}` : "I couldn't work out a name for that after all.",
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error("clips.rename_failed", { error: detail });
      await ctx.reply(`I couldn't rename it: ${detail}`);
    }
  });
}

/** Handles the select and reject buttons under each clip. */
export function registerClipCallbacks(bot: Telegraf) {
  bot.on("callback_query", async (ctx, next) => {
    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!data || !data.startsWith("clip:")) return next();

    const [, action, rawRank] = data.split(":");
    const rank = Number(rawRank);
    if (!Number.isFinite(rank) || (action !== "sel" && action !== "rej")) {
      await ctx.answerCbQuery("I didn't understand that.");
      return;
    }

    const updated = await decideClip(rank, action === "sel" ? "SELECTED" : "REJECTED");
    await ctx.answerCbQuery(updated ? (action === "sel" ? "Selected" : "Rejected") : "I couldn't find that one.");
    // The buttons have done their job; leaving them live invites double taps.
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  });
}
