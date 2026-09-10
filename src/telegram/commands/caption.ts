import type { Telegraf } from "telegraf";
import { aiService } from "../../ai/AIService.js";
import { checkBrandCompliance } from "../../modules/brand/brand.service.js";
import { createApproval, type ApprovalPayload } from "../../modules/approvals/approval.service.js";
import { sendApprovalToTelegram } from "../notify.js";
import { commandTrigger } from "./trigger.js";
import { listKnowledge } from "../../modules/knowledge/knowledge.service.js";

const CAPTION_SYSTEM_PROMPT =
  "Draft social media caption options for independent artist Asher Simmons. " +
  "Produce exactly 3 distinct options, labelled Option 1/2/3, each 1-3 sentences, " +
  "in different registers (e.g. emotional/storytelling, short and punchy, conversational). " +
  "Do not invent any biographical detail, achievement, or event beyond what's given below.";

const MAX_KNOWLEDGE_ITEMS = 25;

/** Grounds the draft in confirmed knowledge so captions use real detail rather than invented colour. */
async function buildCaptionPrompt(idea: string): Promise<string> {
  const known = await listKnowledge({ limit: MAX_KNOWLEDGE_ITEMS });
  if (known.length === 0) return `Post is about: ${idea}`;

  const facts = known.map((item) => `- [${item.category}] ${item.title}: ${item.content}`).join("\n");
  return [
    "Confirmed facts about Asher (the ONLY background you may draw on):",
    facts,
    "",
    `Post is about: ${idea}`,
  ].join("\n");
}

/**
 * The first real end-to-end Level 1→2 AI feature: draft caption options from
 * a free-text idea, run them through the brand compliance stub, and put the
 * result up for approval on Telegram rather than posting anything.
 */
export function registerCaptionCommand(bot: Telegraf) {
  bot.command(commandTrigger("caption"), async (ctx) => {
    const idea = ctx.payload.trim();
    if (!idea) {
      await ctx.reply("Usage: /caption <what this post is about>\nExample: /caption new single Brighter Days is out today");
      return;
    }

    await ctx.reply("Drafting caption options…");

    const prompt = await buildCaptionPrompt(idea);
    const result = await aiService.generate("CAPTION", prompt, { system: CAPTION_SYSTEM_PROMPT });
    const compliance = await checkBrandCompliance(result.text);

    const fields: Record<string, string> = { "Caption options": result.text };
    if (compliance.flags.length > 0) {
      fields["⚠️ Brand check"] = compliance.flags.map((f) => f.reason).join("; ");
    }
    if (compliance.remindersForReview.length > 0) {
      fields["Reminders"] = compliance.remindersForReview.join("; ");
    }

    const payload: ApprovalPayload = {
      title: "New caption draft ready",
      summary: `Idea: ${idea}`,
      fields,
      actions: ["APPROVE", "EDIT", "REGENERATE", "REJECT"],
      editableField: "Caption options",
      regenerate: { taskType: "CAPTION", prompt, targetField: "Caption options" },
    };

    const approval = await createApproval({ level: "LEVEL_2", payload });
    await sendApprovalToTelegram(ctx.telegram, approval);
  });
}
