import type { Telegraf } from "telegraf";
import { getStats, formatStats } from "../../modules/analytics/analytics.service.js";
import { logger } from "../../lib/logger.js";
import { commandTrigger } from "./trigger.js";

export function registerStatsCommand(bot: Telegraf) {
  bot.command(commandTrigger("stats"), async (ctx) => {
    try {
      await ctx.reply(formatStats(await getStats()).slice(0, 4000));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error("stats_failed", { error: detail });
      await ctx.reply(`Couldn't pull your numbers:\n\n${detail.slice(0, 300)}`);
    }
  });
}
