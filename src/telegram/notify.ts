import type { Telegram } from "telegraf";
import type { Approval } from "@prisma/client";
import { attachTelegramMessage } from "../modules/approvals/approval.service.js";
import { renderApprovalMessage, renderResolvedMessage } from "./approvals.render.js";
import { env } from "../config/env.js";

/** Sends a new Approval to Asher's chat with its action buttons, and records the message id so it can be edited later. */
export async function sendApprovalToTelegram(telegram: Telegram, approval: Approval) {
  const { text, keyboard } = renderApprovalMessage(approval);
  const message = await telegram.sendMessage(env.TELEGRAM_ALLOWED_CHAT_ID, text, keyboard);
  await attachTelegramMessage(approval.id, String(message.chat.id), String(message.message_id));
  return message;
}

/** Edits an Approval's Telegram message in place to show its resolved state, removing the buttons. */
export async function updateApprovalMessage(telegram: Telegram, approval: Approval) {
  if (!approval.telegramChatId || !approval.telegramMessageId) return;
  await telegram.editMessageText(approval.telegramChatId, Number(approval.telegramMessageId), undefined, renderResolvedMessage(approval));
}

export async function sendPlainMessage(telegram: Telegram, text: string) {
  return telegram.sendMessage(env.TELEGRAM_ALLOWED_CHAT_ID, text);
}

/**
 * Telegram refuses an upload over this, and there is no way to know before
 * trying other than checking. A preview is a convenience, so being over it is
 * reported rather than treated as a failure.
 */
const MAX_TELEGRAM_UPLOAD_BYTES = 45 * 1024 * 1024;

/**
 * Sends a rendered clip into the chat so Asher can watch it.
 *
 * The whole point of an automatic reframe is that someone sees the result before
 * an audience does: a crop that took the top of his head off is obvious in two
 * seconds of playback and invisible in a description of it. Returns false when
 * the clip was too big to send, so the caller can say so rather than implying he
 * has seen something he hasn't.
 */
export async function sendVideoPreview(
  telegram: Telegram,
  video: { data: Buffer; filename: string; caption?: string },
): Promise<boolean> {
  if (video.data.byteLength > MAX_TELEGRAM_UPLOAD_BYTES) return false;

  await telegram.sendVideo(
    env.TELEGRAM_ALLOWED_CHAT_ID,
    { source: video.data, filename: video.filename },
    {
      caption: video.caption?.slice(0, 1024),
      supports_streaming: true,
    },
  );
  return true;
}
