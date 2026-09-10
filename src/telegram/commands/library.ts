import type { Telegraf } from "telegraf";
import { listAssets } from "../../modules/assets/asset.service.js";
import { listPendingApprovals } from "../../modules/approvals/approval.service.js";

export function registerLibraryCommand(bot: Telegraf) {
  bot.command("library", async (ctx) => {
    const assets = await listAssets({ limit: 10 });
    if (assets.length === 0) {
      await ctx.reply("Your content library is empty. Send me a photo, video, audio file, or document to get started.");
      return;
    }
    const lines = ["CONTENT LIBRARY (most recent)", ""];
    for (const asset of assets) {
      lines.push(`• [${asset.assetType}] ${asset.filename} — ${asset.status}`);
    }
    await ctx.reply(lines.join("\n"));
  });

  bot.command("pending", async (ctx) => {
    const pending = await listPendingApprovals(10);
    if (pending.length === 0) {
      await ctx.reply("Nothing awaiting your approval right now.");
      return;
    }
    const lines = ["AWAITING YOUR APPROVAL", ""];
    for (const approval of pending) {
      const payload = approval.payload as { title?: string };
      lines.push(`• [${approval.level}] ${payload.title ?? approval.type} (id: ${approval.id})`);
    }
    await ctx.reply(lines.join("\n"));
  });
}
