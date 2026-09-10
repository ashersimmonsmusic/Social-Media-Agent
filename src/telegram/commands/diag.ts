import Anthropic from "@anthropic-ai/sdk";
import type { Telegraf } from "telegraf";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { commandTrigger } from "./trigger.js";

/**
 * Answers "why won't it talk to me?" without needing the Railway logs: a 404
 * from the API means the configured model isn't on this key, and a 400 about
 * thinking means the model is too old for adaptive thinking. Both are visible
 * here as the model list the key can actually reach.
 */
export function registerDiagCommand(bot: Telegraf) {
  bot.command(commandTrigger("diag"), async (ctx) => {
    const lines = [
      "DIAGNOSTICS",
      "",
      `Strategy model (chat): ${env.AI_MODEL_STRATEGY}`,
      `Fast model (captions): ${env.AI_MODEL_FAST}`,
      "",
    ];

    try {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const page = await client.models.list({ limit: 60 });

      const configured = new Set([env.AI_MODEL_STRATEGY, env.AI_MODEL_FAST]);
      lines.push("Models your API key can use:");
      for (const model of page.data) {
        const mark = configured.has(model.id) ? " <- in use" : "";
        const adaptive = model.capabilities?.thinking?.types?.adaptive?.supported;
        const thinking = adaptive === true ? "adaptive ok" : adaptive === false ? "no adaptive" : "thinking unknown";
        lines.push(`- ${model.id} (max_tokens ${model.max_tokens ?? "?"}, ${thinking})${mark}`);
      }

      const listed = new Set(page.data.map((m) => m.id));
      const missing = [...configured].filter((id) => !listed.has(id));
      if (missing.length > 0) {
        lines.push(
          "",
          `Not in that list: ${missing.join(", ")}`,
          "If a model isn't listed, calls to it return 404. Set AI_MODEL_STRATEGY in Railway to one of the IDs above.",
        );
      } else {
        lines.push("", "Both configured models are available on this key.");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error("diag_models_failed", { error: detail });
      lines.push(`Couldn't list models: ${detail.slice(0, 300)}`);
    }

    await ctx.reply(lines.join("\n").slice(0, 4000));
  });
}
