import type { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { downloadTelegramFile } from "../download.js";
import { describeAsset, ingestFile } from "../../modules/assets/asset.service.js";
import {
  analyseAttachment,
  canAnalyse,
  resolveMediaType,
  AttachmentTooLargeError,
  UnsupportedAttachmentError,
} from "../../modules/knowledge/attachment.service.js";
import { previewDrafts } from "../../modules/knowledge/knowledge.service.js";
import { createApproval } from "../../modules/approvals/approval.service.js";
import type { KnowledgeImportPayload } from "../commands/learn.js";
import { sendApprovalToTelegram } from "../notify.js";
import { BudgetExceededError } from "../../ai/budget.js";
import { logger } from "../../lib/logger.js";

/** Handles photo/video/audio/voice/document uploads → Content Library (brief §5/§6). */
export function registerUploadHandlers(bot: Telegraf) {
  bot.on(message("photo"), async (ctx) => {
    const largest = ctx.message.photo[ctx.message.photo.length - 1]!;
    const data = await downloadTelegramFile(ctx.telegram, largest.file_id);
    const filename = `photo-${largest.file_id}.jpg`;
    const asset = await ingestFile({ filename, mimeType: "image/jpeg", data, source: "telegram" });
    await ctx.reply(`Filed as a photo asset (${asset.id}). Reading it now…`);
    await analyseAndOffer(ctx, { assetId: asset.id, mediaType: "image/jpeg", data, filename });
  });

  bot.on(message("video"), async (ctx) => {
    const video = ctx.message.video;
    const data = await downloadTelegramFile(ctx.telegram, video.file_id);
    const asset = await ingestFile({
      filename: video.file_name ?? `video-${video.file_id}.mp4`,
      mimeType: video.mime_type ?? "video/mp4",
      data,
      source: "telegram",
    });
    await ctx.reply(`Filed as a video asset (${asset.id}).`);
  });

  bot.on(message("voice"), async (ctx) => {
    const voice = ctx.message.voice;
    const data = await downloadTelegramFile(ctx.telegram, voice.file_id);
    const asset = await ingestFile({
      filename: `voice-note-${voice.file_id}.ogg`,
      mimeType: voice.mime_type ?? "audio/ogg",
      data,
      source: "telegram",
      description: "Voice note",
    });
    await ctx.reply(`Filed as a voice note / audio asset (${asset.id}). Transcription lands in a later phase.`);
  });

  bot.on(message("audio"), async (ctx) => {
    const audio = ctx.message.audio;
    const data = await downloadTelegramFile(ctx.telegram, audio.file_id);
    const asset = await ingestFile({
      filename: audio.file_name ?? `audio-${audio.file_id}.mp3`,
      mimeType: audio.mime_type ?? "audio/mpeg",
      data,
      source: "telegram",
    });
    await ctx.reply(`Filed as a music/audio asset (${asset.id}).`);
  });

  bot.on(message("document"), async (ctx) => {
    const document = ctx.message.document;
    const data = await downloadTelegramFile(ctx.telegram, document.file_id);
    const filename = document.file_name ?? `document-${document.file_id}`;
    const asset = await ingestFile({
      filename,
      mimeType: document.mime_type,
      data,
      source: "telegram",
    });

    const mediaType = resolveMediaType(document.mime_type, filename);
    const readable = canAnalyse(mediaType);
    await ctx.reply(`Filed as a document asset (${asset.id}).${readable ? " Reading it now…" : ""}`);
    if (mediaType && readable) {
      await analyseAndOffer(ctx, { assetId: asset.id, mediaType, data, filename });
    }
  });
}

/**
 * Reads an uploaded image or PDF, saves the description onto the asset so the
 * library becomes searchable, and puts any facts it found in front of Asher for
 * approval. Facts are never stored without that approval, and a file stating no
 * facts (most photographs) raises no card at all.
 */
async function analyseAndOffer(
  ctx: Context,
  input: { assetId: string; mediaType: string; data: Buffer; filename: string },
) {
  await ctx.sendChatAction("typing");

  try {
    const analysis = await analyseAttachment(input);

    if (analysis.summary) {
      await describeAsset(input.assetId, analysis.summary);
    }

    if (analysis.facts.length === 0) {
      await ctx.reply(
        analysis.summary
          ? `Read it — ${analysis.summary}\n\nNo facts in there to record, so I've just saved that description against the file.`
          : "I read it but couldn't make anything out. It's filed either way.",
      );
      return;
    }

    const payload: KnowledgeImportPayload = {
      title: "Facts found in that file — check before I save them",
      summary:
        `From ${input.filename}\n\n` +
        (analysis.summary ? `${analysis.summary}\n\n` : "") +
        `I found ${analysis.facts.length} fact(s). Confirm they're right — I'll treat approved items as fact from then on.`,
      fields: { "What I found": previewDrafts(analysis.facts) },
      actions: ["APPROVE", "REJECT"],
      drafts: analysis.facts,
      sourceType: "DOCUMENT",
      sourceDetail: `${input.filename} (asset ${input.assetId})`,
    };

    const approval = await createApproval({ type: "KNOWLEDGE_IMPORT", level: "LEVEL_2", payload });
    await sendApprovalToTelegram(ctx.telegram, approval);
  } catch (error) {
    if (
      error instanceof BudgetExceededError ||
      error instanceof AttachmentTooLargeError ||
      error instanceof UnsupportedAttachmentError
    ) {
      await ctx.reply(error.message);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    logger.error("attachment_analysis_failed", { assetId: input.assetId, error: detail });
    await ctx.reply(`It's filed, but I couldn't read it:\n\n${detail.slice(0, 300)}`);
  }
}
