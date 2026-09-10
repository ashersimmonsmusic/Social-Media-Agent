import type { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { ingestText } from "../../modules/assets/asset.service.js";
import { checkBrandCompliance } from "../../modules/brand/brand.service.js";
import { getApproval, updateApprovalPayload, type ApprovalPayload } from "../../modules/approvals/approval.service.js";
import { renderApprovalMessage } from "../approvals.render.js";
import { takeAwaitingEdit } from "../editState.js";
import { COMMANDS } from "../commands/trigger.js";

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

    const asset = await ingestText({ text, source: "telegram" });
    await ctx.reply(`Filed as a ${asset.assetType.toLowerCase()} asset (${asset.id}).`);
  });
}
