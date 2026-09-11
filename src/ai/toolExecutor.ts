import type { Telegram } from "telegraf";
import { listAssets, searchAssets, listUnusedAssets, ingestText, getAsset } from "../modules/assets/asset.service.js";
import { signedMediaUrl, MediaUrlUnavailableError } from "../lib/signedMedia.js";
import { listKnowledge, searchKnowledge } from "../modules/knowledge/knowledge.service.js";
import { getOrCreateBrandProfile, listActiveBrandRules } from "../modules/brand/brand.service.js";
import { listPendingApprovals, createApproval, type ApprovalPayload } from "../modules/approvals/approval.service.js";
import { sendApprovalToTelegram } from "../telegram/notify.js";
import { validateForPlatform } from "../modules/social/social.service.js";
import type { SocialPostPayload } from "../telegram/commands/social.js";
import { logger } from "../lib/logger.js";

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
        return assets
          .map((a) => `- ${a.id} | ${a.assetType} | ${a.filename}${a.rawTextContent ? ` | "${a.rawTextContent.slice(0, 200)}"` : ""} | ${a.status}`)
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

      case "propose_social_post": {
        const caption = String(input.caption ?? "").trim();
        const rationale = String(input.rationale ?? "").trim();
        const assetId = typeof input.assetId === "string" ? input.assetId.trim() : undefined;
        if (!caption) return "No caption provided — nothing to propose.";

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
          fields: { Caption: caption, ...(mediaUrl ? { Image: mediaUrl } : {}) },
          actions: ["APPROVE", "EDIT", "REJECT"],
          editableField: "Caption",
          platform: "INSTAGRAM",
          caption,
          mediaUrl,
          assetId,
        };
        const approval = await createApproval({ type: "SOCIAL_POST", level: "LEVEL_2", payload });
        await sendApprovalToTelegram(telegram, approval);
        return `Sent as an Instagram post for approval (${approval.id}). Nothing is published until Asher presses Approve.`;
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
