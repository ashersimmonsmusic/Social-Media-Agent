import type { Telegraf } from "telegraf";
import { env } from "../../config/env.js";
import { registerApprovalAction } from "../../modules/approvals/actions.js";
import type { ApprovalPayload } from "../../modules/approvals/approval.service.js";
import { publishToWebsite } from "../../modules/website/website.service.js";
import type { WebsiteContentType } from "../../modules/website/documents.js";
import { commandTrigger } from "./trigger.js";

/** Carried on a WEBSITE_CONTENT approval so the approved action knows what to write. */
export interface WebsiteContentPayload extends ApprovalPayload {
  contentType: WebsiteContentType;
  document: Record<string, unknown>;
}

export function registerWebsiteCommands(bot: Telegraf) {
  // The only path to a real write. The agent raises the card; this publishes.
  registerApprovalAction("WEBSITE_CONTENT", async (approval) => {
    const payload = approval.payload as unknown as WebsiteContentPayload;
    const result = await publishToWebsite(payload.contentType, payload.document);

    if (result.dryRun) {
      return (
        `DRY RUN — nothing was added to the website.\n\n${result.summary}\n\n` +
        `Set DRY_RUN=false in Railway when you're ready for this to go live.`
      );
    }
    return `Added to ashersimmonsmusic.com — ${result.summary}\n\nIt's live on the site now.`;
  });

  bot.command(commandTrigger("website"), async (ctx) => {
    const lines = ["WEBSITE", "", `Repo: ${env.WEBSITE_REPO}`];

    const sanityReady = Boolean(env.SANITY_PROJECT_ID && env.SANITY_WRITE_TOKEN);
    const githubReady = Boolean(env.GITHUB_TOKEN);

    lines.push(
      "",
      sanityReady
        ? `Content: connected (${env.SANITY_DATASET}) — I can add gigs, press and articles.`
        : "Content: not connected. Set SANITY_PROJECT_ID and SANITY_WRITE_TOKEN in Railway.",
      githubReady
        ? "Code changes: connected — I can file requests for new sections and features."
        : "Code changes: not connected. Set GITHUB_TOKEN in Railway.",
      "",
      env.DRY_RUN ? "DRY_RUN is ON — nothing reaches the site for real." : "DRY_RUN is OFF — approved changes go live.",
      "",
      "What I can add myself: gigs, press mentions, articles.",
      "What needs code (I'll file it for Claude Code): new sections, new kinds of content, design changes.",
    );

    await ctx.reply(lines.join("\n"));
  });
}
