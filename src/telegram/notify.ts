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
