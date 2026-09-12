import type { Telegram } from "telegraf";
import { listAssets, searchAssets, listUnusedAssets, ingestText, getAsset } from "../modules/assets/asset.service.js";
import { signedMediaUrl, MediaUrlUnavailableError } from "../lib/signedMedia.js";
import { describeImageForCaption } from "../modules/knowledge/attachment.service.js";
import { storage } from "../storage/index.js";
import { listKnowledge, searchKnowledge } from "../modules/knowledge/knowledge.service.js";
import { getOrCreateBrandProfile, listActiveBrandRules } from "../modules/brand/brand.service.js";
import { listPendingApprovals, createApproval, type ApprovalPayload } from "../modules/approvals/approval.service.js";
import { sendApprovalToTelegram } from "../telegram/notify.js";
import { validateForPlatform } from "../modules/social/social.service.js";
import { MIN_LEAD_MS } from "../modules/social/scheduler.service.js";
import type { SocialPostPayload } from "../telegram/commands/social.js";
import { publishToWebsite, requestWebsiteChange } from "../modules/website/website.service.js";
import { buildDocument, InvalidDocumentError, WEBSITE_CONTENT_TYPES, type WebsiteContentType } from "../modules/website/documents.js";
import type { WebsiteContentPayload } from "../telegram/commands/website.js";
import { getStats, formatStats } from "../modules/analytics/analytics.service.js";
import { getRecipients } from "../modules/email/newsletter.service.js";
import { listVideos, formatVideoList } from "../modules/drive/drive.service.js";
import type { NewsletterPayload } from "../telegram/commands/newsletter.js";
import { logger } from "../lib/logger.js";

/** Asher is Bristol-based; scheduling reads naturally in his own time. */
const TIMEZONE = "Europe/London";

/** Runs the tools declared in agentTools.ts. Kept separate so the tool
 *  definitions stay free of service/config imports and remain directly testable. */
export function buildToolExecutor(telegram: Telegram) {
  return async function executeTool(name: string, rawInput: unknown): Promise<string> {
    const input = (rawInput ?? {}) as Record<string, unknown>;
    logger.info("agent.tool_call", { tool: name });

    switch (name) {
      case "search_content_library": {
        const query = typeof input.query === "string" ? input.query.trim() : "";
        const assets = query ? await searchAssets(query, 15) : await listAssets({ limit: 15 });
        if (assets.length === 0) return "No matching content in the library.";
        // The description is written by the vision pass on upload — without it
        // here the agent can't tell one photo from another.
        return assets
          .map((a) =>
            [
              `- ${a.id} | ${a.assetType} | ${a.filename}`,
              a.description ? `shows: ${a.description}` : null,
              a.rawTextContent ? `"${a.rawTextContent.slice(0, 200)}"` : null,
              a.status,
            ]
              .filter(Boolean)
              .join(" | "),
          )
          .join("\n");
      }

      case "list_unused_content": {
        const assets = await listUnusedAssets(15);
        if (assets.length === 0) return "Everything in the library has been used at least once.";
        return assets.map((a) => `- ${a.id} | ${a.assetType} | ${a.filename}`).join("\n");
      }

      case "search_knowledge": {
        const query = typeof input.query === "string" ? input.query.trim() : "";
        const items = query ? await searchKnowledge(query, 25) : await listKnowledge({ limit: 40 });
        if (items.length === 0) {
          return "Nothing known. Do not guess — tell Asher you don't have that information, and that /learn <url> can teach you.";
        }
        return items.map((i) => `- [${i.category}] ${i.title}: ${i.content}`).join("\n");
      }

      case "get_brand_bible": {
        const profile = await getOrCreateBrandProfile();
        const rules = await listActiveBrandRules();
        return [
          `Colours: ${JSON.stringify(profile.colors)}`,
          `Visual motifs: ${JSON.stringify(profile.visualMotifs)}`,
          `Voice: ${JSON.stringify(profile.voice)}`,
          `Identity boundaries: ${JSON.stringify(profile.identityBoundaries)}`,
          rules.length > 0 ? `Active rules:\n${rules.map((r) => `- [${r.category}/${r.kind}] ${r.description}`).join("\n")}` : "No brand rules set yet.",
        ].join("\n");
      }

      case "list_pending_approvals": {
        const pending = await listPendingApprovals(15);
        if (pending.length === 0) return "Nothing is waiting for approval.";
        return pending
          .map((a) => {
            const payload = a.payload as { title?: string };
            return `- ${a.id} | ${a.type} | ${payload.title ?? "(untitled)"} | requested ${a.requestedAt.toISOString()}`;
          })
          .join("\n");
      }

      case "save_to_library": {
        const text = typeof input.text === "string" ? input.text : "";
        if (!text.trim()) return "Nothing to save — no text was given.";
        const asset = await ingestText({
          text,
          source: "telegram-conversation",
          description: typeof input.description === "string" ? input.description : undefined,
        });
        return `Saved to the library as ${asset.assetType} asset ${asset.id}.`;
      }

      case "propose_for_approval": {
        const title = String(input.title ?? "Draft for review");
        const summary = String(input.summary ?? "");
        const content = String(input.content ?? "");
        if (!content.trim()) return "Nothing to propose — no content was given.";

        const payload: ApprovalPayload = {
          title,
          summary,
          fields: { Draft: content },
          actions: ["APPROVE", "EDIT", "REJECT"],
          editableField: "Draft",
        };
        const approval = await createApproval({ level: "LEVEL_2", payload });
        await sendApprovalToTelegram(telegram, approval);
        return `Sent to Asher as approval ${approval.id}. He must press a button — nothing has been published or sent.`;
      }

      case "look_at_image": {
        const assetId = String(input.assetId ?? "").trim();
        if (!assetId) return "No asset id given.";
        const asset = await getAsset(assetId);
        if (!asset) return `No asset ${assetId} in the library — check the id with search_content_library.`;
        if (!asset.mimeType?.startsWith("image/")) {
          return `Asset ${assetId} is a ${asset.assetType.toLowerCase()}, not an image — there's nothing to look at.`;
        }
        try {
          const data = await storage.read(asset.storageKey);
          return await describeImageForCaption({ mediaType: asset.mimeType, data, filename: asset.filename });
        } catch (error) {
          return `Couldn't read that image: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      case "propose_social_post": {
        const caption = String(input.caption ?? "").trim();
        const rationale = String(input.rationale ?? "").trim();
        const assetId = typeof input.assetId === "string" ? input.assetId.trim() : undefined;
        if (!caption) return "No caption provided — nothing to propose.";

        // Reject an unusable time now rather than at the approval, which could
        // be hours later and long after he's stopped paying attention.
        let scheduledFor: string | undefined;
        if (typeof input.scheduledFor === "string" && input.scheduledFor.trim()) {
          const when = new Date(input.scheduledFor.trim());
          if (Number.isNaN(when.getTime())) {
            return `I couldn't read "${input.scheduledFor}" as a time. Check current_time and give a full ISO timestamp.`;
          }
          if (when.getTime() - Date.now() < MIN_LEAD_MS) {
            return `${when.toISOString()} is in the past or too close to now. Check current_time and pick a later slot.`;
          }
          scheduledFor = when.toISOString();
        }

        // A library asset needs a public link Instagram can fetch; anything
        // else has to already be public.
        let mediaUrl = typeof input.mediaUrl === "string" ? input.mediaUrl.trim() : undefined;
        if (assetId) {
          const asset = await getAsset(assetId);
          if (!asset) return `No asset ${assetId} in the library — check the id with search_content_library.`;
          if (!asset.mimeType?.startsWith("image/")) {
            return `Asset ${assetId} is a ${asset.assetType.toLowerCase()}, not an image. Instagram needs an image.`;
          }
          try {
            mediaUrl = signedMediaUrl(assetId);
          } catch (error) {
            return error instanceof MediaUrlUnavailableError ? error.message : String(error);
          }
        }

        // Check the platform's own rules first: raising a card that would fail
        // on approval is worse than saying now what's wrong with it.
        const validation = await validateForPlatform("INSTAGRAM", { caption, mediaUrl });
        if (!validation.ok) {
          return (
            `Not proposed — Instagram would reject this: ${validation.problems.join(" ")} ` +
            `Tell Asher what's needed instead of raising a card that can't go out.`
          );
        }

        const payload: SocialPostPayload = {
          title: "Instagram post — approve to publish",
          summary: rationale || "Drafted for your Instagram.",
          fields: {
            Caption: caption,
            ...(mediaUrl ? { Image: mediaUrl } : {}),
            // Shown on the card so he can see he's approving a future post,
            // not an immediate one.
            ...(scheduledFor
              ? {
                  "Goes out": new Date(scheduledFor).toLocaleString("en-GB", {
                    timeZone: TIMEZONE,
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                }
              : {}),
          },
          actions: ["APPROVE", "EDIT", "REJECT"],
          editableField: "Caption",
          platform: "INSTAGRAM",
          caption,
          mediaUrl,
          assetId,
          ...(scheduledFor ? { scheduledFor } : {}),
        };
        const approval = await createApproval({ type: "SOCIAL_POST", level: "LEVEL_2", payload });
        await sendApprovalToTelegram(telegram, approval);
        return scheduledFor
          ? `Sent for approval (${approval.id}). When Asher approves it, it goes out at ${scheduledFor} — not before.`
          : `Sent as an Instagram post for approval (${approval.id}). Nothing is published until Asher presses Approve.`;
      }

      case "propose_newsletter": {
        const subject = String(input.subject ?? "").trim();
        const body = String(input.body ?? "").trim();
        const rationale = String(input.rationale ?? "").trim();
        if (!subject || !body) return "A newsletter needs both a subject and a body.";

        // Check the list is readable before raising a card — discovering at
        // approval that there's nobody to send to wastes his decision.
        let recipientCount: number;
        try {
          recipientCount = (await getRecipients()).length;
        } catch (error) {
          return `Can't send email yet: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (recipientCount === 0) return "Nobody is subscribed yet, so there's nobody to send to.";

        const payload: NewsletterPayload = {
          title: "Newsletter — approve to send",
          summary: `${rationale || "Drafted for your list."}\n\nGoes to ${recipientCount} subscriber(s). Email can't be unsent.`,
          fields: { Subject: subject, Email: body },
          actions: ["APPROVE", "EDIT", "REJECT"],
          editableField: "Email",
          subject,
          body,
        };
        const approval = await createApproval({ type: "NEWSLETTER", level: "LEVEL_2", payload });
        await sendApprovalToTelegram(telegram, approval);
        return `Sent for approval (${approval.id}). It reaches ${recipientCount} subscriber(s) only once Asher approves it.`;
      }

      case "list_drive_videos": {
        try {
          return formatVideoList(await listVideos(15));
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }

      case "get_stats": {
        try {
          return formatStats(await getStats());
        } catch (error) {
          return `Couldn't read the numbers: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      case "current_time": {
        const now = new Date();
        return [
          `UTC: ${now.toISOString()}`,
          `Asher's local time (${TIMEZONE}): ${now.toLocaleString("en-GB", { timeZone: TIMEZONE, dateStyle: "full", timeStyle: "short" })}`,
        ].join("\n");
      }

      case "propose_website_content": {
        const contentType = String(input.contentType ?? "") as WebsiteContentType;
        if (!WEBSITE_CONTENT_TYPES.includes(contentType)) {
          return `The site has no "${contentType}" content type. It has: ${WEBSITE_CONTENT_TYPES.join(", ")}. Use request_website_change for anything else.`;
        }
        const fields = (input.fields ?? {}) as Record<string, unknown>;
        const rationale = String(input.rationale ?? "").trim();

        // Validate against the real schema now — Sanity accepts almost anything,
        // so a bad document lands silently broken rather than erroring.
        let summary: string;
        let document: Record<string, unknown>;
        try {
          const built = buildDocument(contentType, fields);
          summary = built.summary;
          document = built.doc;
        } catch (error) {
          if (error instanceof InvalidDocumentError) {
            return `Not proposed — ${error.message} Ask Asher for what's missing rather than guessing it.`;
          }
          throw error;
        }

        const payload: WebsiteContentPayload = {
          title: `Add to your website — ${contentType}`,
          summary: rationale || summary,
          fields: Object.fromEntries(
            Object.entries(document)
              .filter(([key]) => key !== "_type")
              .map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value)]),
          ),
          actions: ["APPROVE", "REJECT"],
          contentType,
          document,
        };
        const approval = await createApproval({ type: "WEBSITE_CONTENT", level: "LEVEL_2", payload });
        await sendApprovalToTelegram(telegram, approval);
        return `Sent for approval (${approval.id}). Nothing is on the site until Asher presses Approve.`;
      }

      case "request_website_change": {
        const title = String(input.title ?? "").trim();
        const details = String(input.details ?? "").trim();
        if (!title || !details) return "I need a title and details before I can file that.";
        try {
          const url = await requestWebsiteChange({
            title,
            body: `${details}\n\n---\nFiled from Telegram by Asher's agent.`,
          });
          return `Filed with Claude Code: ${url}. Tell Asher it's written down for a developer session to pick up — it is NOT done.`;
        } catch (error) {
          return `Couldn't file that: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      case "propose_behavior_rule": {
        const rule = String(input.rule ?? "").trim();
        const rationale = String(input.rationale ?? "").trim();
        if (!rule) return "No rule text provided — nothing to propose.";

        const payload: ApprovalPayload = {
          title: "New standing instruction",
          summary: rationale || "Proposed by the agent based on your feedback.",
          fields: {
            "Instruction": rule,
            "Why": rationale || "(no rationale given)",
          },
          actions: ["APPROVE", "REJECT"],
        };
        const approval = await createApproval({ type: "BEHAVIOR_RULE", level: "LEVEL_2", payload });
        await sendApprovalToTelegram(telegram, approval);
        return `Sent as a standing-instruction proposal (${approval.id}). Once Asher approves, I'll follow this in every conversation.`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  };
}
