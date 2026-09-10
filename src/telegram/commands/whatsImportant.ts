import type { Telegraf } from "telegraf";
import { listPendingApprovals } from "../../modules/approvals/approval.service.js";
import { listUnusedAssets } from "../../modules/assets/asset.service.js";

/**
 * Brief §53/§62's "What's important?" command. A real priority engine
 * needs deadlines, campaigns and opportunities (Phases 4-6), which don't
 * exist yet. Phase 1 reports honestly on what it can actually see —
 * pending approvals and unused content — rather than inventing priorities.
 */
export function registerWhatsImportantCommand(bot: Telegraf) {
  bot.command(["whatsimportant", "important"], async (ctx) => {
    const [pending, unused] = await Promise.all([listPendingApprovals(5), listUnusedAssets(5)]);

    const lines: string[] = ["WHAT'S IMPORTANT RIGHT NOW"];

    if (pending.length > 0) {
      lines.push("", `🔔 ${pending.length} item(s) awaiting your approval — check the messages above, or /pending.`);
    }
    if (unused.length > 0) {
      lines.push(
        "",
        `📦 ${unused.length} content asset(s) haven't been used in anything yet: ` +
          unused.map((a) => a.filename).join(", "),
      );
    }
    if (pending.length === 0 && unused.length === 0) {
      lines.push("", "Nothing outstanding that I can see.");
    }

    lines.push(
      "",
      "Note: I can't yet see release deadlines, campaign performance, or industry " +
        "opportunities — that's built in a later phase, so this list is deliberately partial.",
    );

    await ctx.reply(lines.join("\n"));
  });
}
