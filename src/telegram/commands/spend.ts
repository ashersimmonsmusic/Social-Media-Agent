import type { Telegraf } from "telegraf";
import { env } from "../../config/env.js";
import { getMonthToDateAiSpend, getSpendBreakdown } from "../../ai/budget.js";
import { commandTrigger } from "./trigger.js";

export function registerSpendCommand(bot: Telegraf) {
  bot.command(commandTrigger("spend"), async (ctx) => {
    const [spend, breakdown] = await Promise.all([getMonthToDateAiSpend(), getSpendBreakdown()]);
    const budget = env.AI_MONTHLY_BUDGET_USD;

    const lines = ["AI SPEND THIS MONTH", ""];

    if (budget > 0) {
      const percent = Math.round((spend / budget) * 100);
      lines.push(`$${spend.toFixed(2)} of $${budget.toFixed(2)} (${percent}%)`);
      lines.push(`$${Math.max(0, budget - spend).toFixed(2)} left`);
    } else {
      lines.push(`$${spend.toFixed(2)} — no budget limit set`);
    }

    if (breakdown.length > 0) {
      lines.push("", "Where it went:");
      for (const row of breakdown) {
        lines.push(`- ${row.taskType}: $${row.costUsd.toFixed(2)} over ${row.calls} call(s)`);
      }
    } else {
      lines.push("", "No AI calls logged yet this month.");
    }

    lines.push("", `Model: ${env.AI_MODEL_STRATEGY} (chat), ${env.AI_MODEL_FAST} (captions)`);
    await ctx.reply(lines.join("\n"));
  });
}
