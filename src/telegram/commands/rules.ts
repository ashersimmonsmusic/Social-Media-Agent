import type { Telegraf } from "telegraf";
import { registerApprovalAction } from "../../modules/approvals/actions.js";
import { addBrandRule, listActiveBrandRules } from "../../modules/brand/brand.service.js";
import type { ApprovalPayload } from "../../modules/approvals/approval.service.js";
import { commandTrigger } from "./trigger.js";

export function registerRulesCommand(bot: Telegraf) {
  // What happens once Asher approves a proposed behavior rule: store it as an
  // active BEHAVIOR rule so it loads into every future conversation.
  registerApprovalAction("BEHAVIOR_RULE", async (approval) => {
    const payload = approval.payload as unknown as ApprovalPayload;
    const rule = payload.fields?.["Instruction"] ?? "";
    if (!rule.trim()) return "Nothing to save — the rule text was empty.";

    await addBrandRule({
      category: "BEHAVIOR",
      kind: "PERMANENT_PREFERENCE",
      description: rule,
      source: "AGENT_PROPOSED",
    });

    return `Standing instruction saved. I'll follow this in every conversation from now on.`;
  });

  bot.command(commandTrigger("rules"), async (ctx) => {
    const rules = await listActiveBrandRules("BEHAVIOR");

    if (rules.length === 0) {
      await ctx.reply(
        "No standing instructions set yet.\n\n" +
          "To add one, just tell me to change how I respond — e.g. \"Always lead with TikTok\" or \"Stop giving me lists, just give me the best option\" — and I'll propose a rule for you to approve.",
      );
      return;
    }

    const lines = ["YOUR STANDING INSTRUCTIONS", "", ...rules.map((r, i) => `${i + 1}. ${r.description}`)];
    await ctx.reply(lines.join("\n"));
  });
}
