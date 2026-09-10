import type { Telegraf } from "telegraf";
import { getApproval, resolveApproval, updateApprovalPayload, type ApprovalPayload } from "../modules/approvals/approval.service.js";
import { checkBrandCompliance } from "../modules/brand/brand.service.js";
import { renderApprovalMessage, renderResolvedMessage } from "./approvals.render.js";
import { updateApprovalMessage } from "./notify.js";
import { setAwaitingEdit } from "./editState.js";
import { aiService } from "../ai/AIService.js";
import type { TaskType } from "../ai/types.js";
import { logger } from "../lib/logger.js";

const RESOLVING_ACTIONS: Record<string, "APPROVED" | "REJECTED" | "CANCELLED"> = {
  APPROVE: "APPROVED",
  SEND: "APPROVED",
  CONFIRM: "APPROVED",
  REJECT: "REJECTED",
  DONT_SEND: "REJECTED",
  CANCEL: "CANCELLED",
};

export function registerApprovalCallbacks(bot: Telegraf) {
  bot.on("callback_query", async (ctx) => {
    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    if (!data || !data.startsWith("approval:")) return;

    const [, approvalId, action] = data.split(":");
    if (!approvalId || !action) return;

    const approval = await getApproval(approvalId);
    if (!approval) {
      await ctx.answerCbQuery("This approval no longer exists.");
      return;
    }
    if (approval.status !== "PENDING") {
      await ctx.answerCbQuery(`Already ${approval.status.toLowerCase()}.`);
      return;
    }

    const chatId = String(ctx.chat?.id ?? "");

    if (action in RESOLVING_ACTIONS) {
      const status = RESOLVING_ACTIONS[action]!;
      const resolved = await resolveApproval(approvalId, status, chatId);
      await ctx.answerCbQuery(status);
      await ctx.editMessageText(renderResolvedMessage(resolved));
      return;
    }

    if (action === "EDIT") {
      const payload = approval.payload as unknown as ApprovalPayload;
      if (!payload.editableField) {
        await ctx.answerCbQuery("Nothing editable on this item yet.");
        return;
      }
      setAwaitingEdit(chatId, approvalId);
      await ctx.answerCbQuery("Reply with your edit");
      await ctx.reply(`Reply with the new text for "${payload.editableField}" and I'll update it.`);
      return;
    }

    if (action === "REGENERATE") {
      const payload = approval.payload as unknown as ApprovalPayload;
      if (!payload.regenerate) {
        await ctx.answerCbQuery("Regeneration isn't available for this item.");
        return;
      }
      await ctx.answerCbQuery("Regenerating…");
      try {
        const result = await aiService.generate(payload.regenerate.taskType as TaskType, payload.regenerate.prompt);
        const compliance = await checkBrandCompliance(result.text);
        const updatedPayload: ApprovalPayload = {
          ...payload,
          fields: { ...payload.fields, [payload.regenerate.targetField]: result.text },
        };
        if (compliance.flags.length > 0) {
          updatedPayload.fields = {
            ...updatedPayload.fields,
            "⚠️ Brand check": compliance.flags.map((f) => f.reason).join("; "),
          };
        }
        await updateApprovalPayload(approvalId, updatedPayload);
        const refreshed = await getApproval(approvalId);
        if (refreshed) {
          const { text, keyboard } = renderApprovalMessage(refreshed);
          await ctx.editMessageText(text, keyboard);
        }
      } catch (error) {
        logger.error("regenerate_failed", { approvalId, error: String(error) });
        await ctx.reply("Regeneration failed — the original draft is unchanged.");
      }
      return;
    }
  });
}
