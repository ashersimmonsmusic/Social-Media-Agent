import { createHmac } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { recordAudit } from "../audit/audit.service.js";
import { selectRows, isSupabaseConfigured } from "../analytics/supabase.client.js";

/**
 * Sending is chunked because Resend's batch endpoint caps how many messages one
 * call may carry; this also means a failure part-way through is bounded.
 */
const BATCH_SIZE = 100;

export class NewsletterNotConfiguredError extends Error {
  constructor(missing: string) {
    super(`${missing} isn't set in Railway, so I can't send email. Nothing has gone out.`);
    this.name = "NewsletterNotConfiguredError";
  }
}

export class NewsletterSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewsletterSendError";
  }
}

/**
 * Signs an unsubscribe link the website will accept. Must stay byte-identical
 * to lib/newsletter/unsubscribe.ts there — a mismatch means every unsubscribe
 * link silently fails, which is worse than having none.
 */
function unsubscribeUrl(email: string): string {
  const secret = env.NEWSLETTER_UNSUBSCRIBE_SECRET;
  if (!secret) throw new NewsletterNotConfiguredError("NEWSLETTER_UNSUBSCRIBE_SECRET");
  const token = createHmac("sha256", secret).update(email.trim().toLowerCase()).digest("hex");
  const base = env.WEBSITE_URL.replace(/\/$/, "");
  return `${base}/unsubscribe?e=${encodeURIComponent(email)}&t=${token}`;
}

/** Everyone who hasn't unsubscribed. */
export async function getRecipients(): Promise<string[]> {
  if (!isSupabaseConfigured()) throw new NewsletterNotConfiguredError("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");

  const recipients: string[] = [];
  // PostgREST caps a single response, so page rather than assume one call
  // returned everyone — a silently truncated list means fans stop getting mail.
  for (let offset = 0; ; offset += 1000) {
    const { rows } = await selectRows("newsletter_subscribers", {
      select: "email",
      unsubscribed_at: "is.null",
      order: "created_at.asc",
      limit: "1000",
      offset: String(offset),
    });
    recipients.push(...rows.map((row) => String(row.email)).filter(Boolean));
    if (rows.length < 1000) break;
  }
  return recipients;
}

function renderHtml(bodyHtml: string, unsubscribe: string): string {
  return [
    `<div style="font-family:system-ui,-apple-system,sans-serif;font-size:16px;line-height:1.6;color:#1a1a1a;max-width:600px">`,
    bodyHtml,
    `<hr style="margin:40px 0 16px;border:none;border-top:1px solid #ddd">`,
    `<p style="font-size:13px;color:#666">`,
    `You're getting this because you signed up at ashersimmonsmusic.com.<br>`,
    `<a href="${unsubscribe}" style="color:#666">Unsubscribe</a>`,
    `</p></div>`,
  ].join("");
}

function toHtml(prose: string): string {
  return prose
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface SendResult {
  sent: number;
  failed: number;
  dryRun: boolean;
}

/**
 * Sends the newsletter. Only ever called from the approved-action handler —
 * email to real people is irreversible, so nothing reaches here without Asher
 * pressing Approve.
 */
export async function sendNewsletter(input: { subject: string; body: string }): Promise<SendResult> {
  const recipients = await getRecipients();
  if (recipients.length === 0) {
    throw new NewsletterSendError("Nobody is subscribed, so there's nobody to send to.");
  }
  // Fail before sending anything rather than part-way through the list.
  unsubscribeUrl(recipients[0]!);

  if (env.DRY_RUN) {
    await recordAudit({
      action: "newsletter.send_dry_run",
      entityType: "Newsletter",
      actorType: "SYSTEM",
      details: { subject: input.subject, recipientCount: recipients.length },
    });
    logger.info("newsletter.send_dry_run", { recipients: recipients.length });
    return { sent: recipients.length, failed: 0, dryRun: true };
  }

  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) throw new NewsletterNotConfiguredError("RESEND_API_KEY");

  const bodyHtml = toHtml(input.body);
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    // One message per recipient, so each carries its own unsubscribe link and
    // nobody sees anyone else's address.
    const payload = batch.map((email) => {
      const url = unsubscribeUrl(email);
      return {
        from: env.RESEND_FROM_EMAIL,
        to: [email],
        subject: input.subject,
        html: renderHtml(bodyHtml, url),
        headers: {
          "List-Unsubscribe": `<${url.replace("/unsubscribe?", "/api/unsubscribe?")}>, <${url}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      };
    });

    try {
      const response = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const text = await response.text();
        failed += batch.length;
        logger.error("newsletter.batch_failed", { status: response.status, detail: text.slice(0, 200) });
      } else {
        sent += batch.length;
      }
    } catch (error) {
      failed += batch.length;
      logger.error("newsletter.batch_error", { error: String(error) });
    }
  }

  await recordAudit({
    action: "newsletter.sent",
    entityType: "Newsletter",
    actorType: "ASHER",
    details: { subject: input.subject, sent, failed },
  });

  if (sent === 0) throw new NewsletterSendError("Every batch was rejected — nothing was delivered.");
  return { sent, failed, dryRun: false };
}
