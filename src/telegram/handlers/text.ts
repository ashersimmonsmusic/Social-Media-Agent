import type { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { ingestText } from "../../modules/assets/asset.service.js";
import { checkBrandCompliance } from "../../modules/brand/brand.service.js";
import { getApproval, updateApprovalPayload, type ApprovalPayload } from "../../modules/approvals/approval.service.js";
import { renderApprovalMessage } from "../approvals.render.js";
import { takeAwaitingEdit } from "../editState.js";
import { COMMANDS } from "../commands/trigger.js";
import { converseWithAsher } from "../../ai/ConversationService.js";
import { logger } from "../../lib/logger.js";

/**
 * Handles plain text messages that are NOT commands. Registered last so
 * commands (matched by Telegraf's Composer) never reach here.
 */
export function registerTextHandler(bot: Telegraf) {
  bot.on(message("text"), async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text;

    const awaitingApprovalId = takeAwaitingEdit(chatId);
    if (awaitingApprovalId) {
      const approval = await getApproval(awaitingApprovalId);
      if (approval && approval.status === "PENDING") {
        const payload = approval.payload as unknown as ApprovalPayload;
        const field = payload.editableField;
        if (field) {
          const compliance = await checkBrandCompliance(text);
          const updatedPayload: ApprovalPayload = { ...payload, fields: { ...payload.fields, [field]: text } };
          if (compliance.flags.length > 0) {
            updatedPayload.fields = {
              ...updatedPayload.fields,
              "⚠️ Brand check": compliance.flags.map((f) => f.reason).join("; "),
            };
          }
          await updateApprovalPayload(awaitingApprovalId, updatedPayload);
          const refreshed = await getApproval(awaitingApprovalId);
          if (refreshed) {
            const { text: rendered, keyboard } = renderApprovalMessage(refreshed);
            await ctx.reply(`Updated:\n\n${rendered}`, keyboard);
          }
          return;
        }
      }
    }

    // Reaching here with a slash-prefixed message means no command handler
    // matched it. Filing it as content would bury a typo in the library with
    // no feedback, so say so instead.
    if (text.startsWith("/")) {
      const known = COMMANDS.map((c) => `/${c.command}`).join(", ");
      await ctx.reply(`I don't recognise that command. Try one of: ${known}`);
      return;
    }

    // A bare link is unambiguous — file it rather than spending a model call
    // deciding what an obvious reference link is.
    if (isBareUrl(text)) {
      const asset = await ingestText({ text, source: "telegram" });
      await ctx.reply(`Filed that link (${asset.id}). Want me to read it and learn from it? Use /learn ${text.trim()}`);
      return;
    }

    // Everything else is a conversation. The agent decides whether Asher is
    // asking something or handing over content to keep, and uses its tools
    // accordingly — none of which can publish, send, or spend.
    await ctx.sendChatAction("typing");
    try {
      const reply = await converseWithAsher({ telegram: ctx.telegram, telegramChatId: chatId, message: text });
      await ctx.reply(reply || "I didn't have anything useful to say to that — try me again?");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error("conversation_failed", { error: detail });
      await ctx.reply(`Hit an error — here's the detail so we can fix it:\n\n${detail.slice(0, 400)}`);
    }
  });
}

function isBareUrl(text: string): boolean {
  const trimmed = text.trim();
  if (/\s/.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
