import type { Telegraf } from "telegraf";
import { commandTrigger } from "./trigger.js";

export function registerStartCommand(bot: Telegraf) {
  bot.command(commandTrigger("start"), async (ctx) => {
    await ctx.reply(
      "Asher's AI Artist Agent is online.\n\n" +
        "Just talk to me normally — ask what you should post, think through a release, " +
        "or hand me a quote to keep. Send a photo, video, audio file or document and " +
        "I'll file it in your content library.\n\n" +
        "Commands:\n" +
        "/whatsimportant — top priorities right now\n" +
        "/library — recent content library items\n" +
        "/brand — view your Brand Bible summary\n" +
        "/caption <idea> — draft caption options for review\n" +
        "/learn <url> — read a web page and learn facts about you\n" +
        "/knowledge — what I currently know about you\n" +
        "/reset — start a fresh conversation",
    );
  });
}
