import type { Telegraf } from "telegraf";
import { commandTrigger } from "./trigger.js";

export function registerStartCommand(bot: Telegraf) {
  bot.command(commandTrigger("start"), async (ctx) => {
    await ctx.reply(
      "Asher's AI Artist Agent is online.\n\n" +
        "Send me a photo, video, audio file, document, or a piece of text/a quote and " +
        "I'll file it in your content library.\n\n" +
        "Commands:\n" +
        "/whatsimportant — top priorities right now\n" +
        "/library — recent content library items\n" +
        "/brand — view your Brand Bible summary\n" +
        "/caption <idea> — draft caption options for review",
    );
  });
}
