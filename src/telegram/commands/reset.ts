import type { Telegraf } from "telegraf";
import { clearHistory } from "../../ai/ConversationService.js";
import { commandTrigger } from "./trigger.js";

export function registerResetCommand(bot: Telegraf) {
  bot.command(commandTrigger("reset"), async (ctx) => {
    const cleared = await clearHistory(String(ctx.chat.id));
    await ctx.reply(
      `Cleared ${cleared} message(s) of chat history — we're starting fresh.\n\n` +
        "Your content library, knowledge base and approvals are untouched.",
    );
  });
}
