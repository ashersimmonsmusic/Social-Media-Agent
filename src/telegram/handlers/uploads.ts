import type { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { downloadTelegramFile } from "../download.js";
import { ingestFile } from "../../modules/assets/asset.service.js";

/** Handles photo/video/audio/voice/document uploads → Content Library (brief §5/§6). */
export function registerUploadHandlers(bot: Telegraf) {
  bot.on(message("photo"), async (ctx) => {
    const largest = ctx.message.photo[ctx.message.photo.length - 1]!;
    const data = await downloadTelegramFile(ctx.telegram, largest.file_id);
    const asset = await ingestFile({ filename: `photo-${largest.file_id}.jpg`, mimeType: "image/jpeg", data, source: "telegram" });
    await ctx.reply(`Filed as a photo asset (${asset.id}). Add a description or tags any time.`);
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
    const asset = await ingestFile({
      filename: document.file_name ?? `document-${document.file_id}`,
      mimeType: document.mime_type,
      data,
      source: "telegram",
    });
    await ctx.reply(`Filed as a document asset (${asset.id}).`);
  });
}
