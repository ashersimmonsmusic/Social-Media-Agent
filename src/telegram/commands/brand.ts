import type { Telegraf } from "telegraf";
import { getOrCreateBrandProfile, listActiveBrandRules, type BrandVoice } from "../../modules/brand/brand.service.js";

export function registerBrandCommand(bot: Telegraf) {
  bot.command("brand", async (ctx) => {
    const profile = await getOrCreateBrandProfile();
    const voice = (profile.voice as BrandVoice) ?? {};
    const rules = await listActiveBrandRules();

    const lines = [
      "BRAND BIBLE SUMMARY",
      "",
      `Colours: ${JSON.stringify(profile.colors)}`,
      `Visual motifs: ${JSON.stringify(profile.visualMotifs)}`,
      `Tone words: ${(voice.toneWords ?? []).join(", ") || "(none set)"}`,
      `Words avoided: ${(voice.wordsAvoided ?? []).join(", ") || "(none set)"}`,
      `Identity boundaries: ${JSON.stringify(profile.identityBoundaries)}`,
      "",
      `Active brand rules: ${rules.length}`,
    ];

    await ctx.reply(lines.join("\n"));
  });
}
