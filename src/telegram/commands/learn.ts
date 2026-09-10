import type { Telegraf } from "telegraf";
import { createApproval, type ApprovalPayload } from "../../modules/approvals/approval.service.js";
import { registerApprovalAction } from "../../modules/approvals/actions.js";
import type { KnowledgeSourceType } from "@prisma/client";
import { storeKnowledgeItems, countKnowledge, listKnowledge, previewDrafts, type KnowledgeDraft } from "../../modules/knowledge/knowledge.service.js";
import { extractKnowledgeFromPage, NotEnoughContentError } from "../../modules/knowledge/extract.service.js";
import { fetchPage, PageFetchError } from "../../modules/knowledge/webPage.service.js";
import { sendApprovalToTelegram } from "../notify.js";
import { commandTrigger } from "./trigger.js";
import { logger } from "../../lib/logger.js";
import { BudgetExceededError } from "../../ai/budget.js";

export interface KnowledgeImportPayload extends ApprovalPayload {
  drafts: KnowledgeDraft[];
  /** Defaults to WEBSITE for cards raised before this field existed. */
  sourceType?: KnowledgeSourceType;
  sourceUrl?: string;
  sourceDetail?: string;
}

export function registerLearnCommand(bot: Telegraf) {
  // What happens once Asher approves an import: the drafts become stored
  // knowledge, marked FACT because he has confirmed them himself.
  registerApprovalAction("KNOWLEDGE_IMPORT", async (approval) => {
    const payload = approval.payload as unknown as KnowledgeImportPayload;
    const stored = await storeKnowledgeItems(
      payload.drafts,
      {
        sourceType: payload.sourceType ?? "WEBSITE",
        sourceUrl: payload.sourceUrl,
        sourceDetail: payload.sourceDetail,
      },
      "FACT",
    );
    const total = await countKnowledge();
    return `Saved ${stored.length} fact(s) to your knowledge base (${total} total). I'll use these instead of guessing.`;
  });

  bot.command(commandTrigger("learn"), async (ctx) => {
    const url = ctx.payload.trim();
    if (!url) {
      await ctx.reply("Usage: /learn <url>\nExample: /learn ashersimmonsmusic.com");
      return;
    }

    await ctx.reply(`Reading ${url}…`);

    let drafts: KnowledgeDraft[];
    let sourceUrl: string;
    try {
      const page = await fetchPage(url);
      sourceUrl = page.url;
      drafts = await extractKnowledgeFromPage(page);
    } catch (error) {
      if (error instanceof PageFetchError || error instanceof NotEnoughContentError) {
        await ctx.reply(`I couldn't learn from that page.\n\n${error.message}`);
        return;
      }
      if (error instanceof BudgetExceededError) {
        await ctx.reply(error.message);
        return;
      }
      logger.error("learn.failed", { url, error: String(error) });
      await ctx.reply("Something went wrong reading that page. Nothing has been saved.");
      return;
    }

    if (drafts.length === 0) {
      await ctx.reply("I read that page but couldn't find any clear facts to record. Nothing has been saved.");
      return;
    }

    const payload: KnowledgeImportPayload = {
      title: "Knowledge found — check before I save it",
      summary: `From ${sourceUrl}\n\nI found ${drafts.length} fact(s). Read them and confirm they're right — I'll treat approved items as fact from then on.`,
      fields: { "What I found": previewDrafts(drafts) },
      actions: ["APPROVE", "REJECT"],
      drafts,
      sourceType: "WEBSITE",
      sourceUrl,
    };

    const approval = await createApproval({ type: "KNOWLEDGE_IMPORT", level: "LEVEL_2", payload });
    await sendApprovalToTelegram(ctx.telegram, approval);
  });

  bot.command(commandTrigger("knowledge"), async (ctx) => {
    const items = await listKnowledge({ limit: 30 });
    if (items.length === 0) {
      await ctx.reply("I don't know anything about you yet. Try /learn ashersimmonsmusic.com to teach me from your website.");
      return;
    }
    const lines = ["WHAT I KNOW ABOUT YOU", ""];
    for (const item of items) {
      lines.push(`• [${item.category}] ${item.title}: ${item.content}`);
    }
    await ctx.reply(lines.join("\n").slice(0, 4000));
  });
}
