import type { Telegraf } from "telegraf";
import { env } from "../../config/env.js";
import { registerApprovalAction } from "../../modules/approvals/actions.js";
import type { ApprovalPayload } from "../../modules/approvals/approval.service.js";
import { getRecipients, sendNewsletter } from "../../modules/email/newsletter.service.js";
import { logger } from "../../lib/logger.js";
import { commandTrigger } from "./trigger.js";

/** Carried on a NEWSLETTER approval so the approved action knows what to send. */
export interface NewsletterPayload extends ApprovalPayload {
  subject: string;
  body: string;
}

export function registerNewsletterCommand(bot: Telegraf) {
  // The only path to a real send. Email to real people can't be recalled, so
  // nothing reaches sendNewsletter without this button press.
  registerApprovalAction("NEWSLETTER", async (approval) => {
    const payload = approval.payload as unknown as NewsletterPayload;
    const result = await sendNewsletter({
      subject: payload.fields?.["Subject"] ?? payload.subject,
      body: payload.fields?.["Email"] ?? payload.body,
    });

    if (result.dryRun) {
      return (
        `DRY RUN — no email was sent.\n\nIt would have gone to ${result.sent} subscriber(s). ` +
        `Set DRY_RUN=false in Railway when you're ready to send for real.`
      );
    }
    const failed = result.failed > 0 ? ` ${result.failed} failed — check the logs.` : "";
    return `Sent to ${result.sent} subscriber(s).${failed}`;
  });

  bot.command(commandTrigger("newsletter"), async (ctx) => {
    const lines = ["NEWSLETTER", ""];
    try {
      const recipients = await getRecipients();
      lines.push(`${recipients.length} subscriber(s) would receive the next send.`);
    } catch (error) {
      lines.push(`Can't read the list: ${error instanceof Error ? error.message : String(error)}`);
      logger.error("newsletter.status_failed", { error: String(error) });
    }

    lines.push(
      "",
      env.RESEND_API_KEY ? "Sending: connected." : "Sending: not connected — set RESEND_API_KEY in Railway.",
      env.NEWSLETTER_UNSUBSCRIBE_SECRET
        ? "Unsubscribe links: working."
        : "Unsubscribe links: NOT set up — set NEWSLETTER_UNSUBSCRIBE_SECRET. I won't send without it.",
      "",
      env.DRY_RUN ? "DRY_RUN is ON — nothing actually sends." : "DRY_RUN is OFF — an approved send goes out for real.",
      "",
      "Ask me to write a newsletter and I'll put it in front of you before anything goes out.",
    );

    await ctx.reply(lines.join("\n"));
  });
}
