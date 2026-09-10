import type { Approval, ApprovalType } from "@prisma/client";
import { recordAudit } from "../audit/audit.service.js";
import { logger } from "../../lib/logger.js";

/**
 * What actually happens once Asher approves something. Returns a short line
 * to report back to him, or undefined if there's nothing to say.
 */
export type ApprovalActionHandler = (approval: Approval) => Promise<string | undefined>;

const handlers = new Map<ApprovalType, ApprovalActionHandler>();

export function registerApprovalAction(type: ApprovalType, handler: ApprovalActionHandler) {
  handlers.set(type, handler);
}

export interface ApprovalActionOutcome {
  ok: boolean;
  message?: string;
}

/**
 * Runs the action an approval authorises. A failure here must never be
 * reported as success (brief §45) — the caller surfaces `ok: false` to Asher
 * along with what didn't happen.
 */
export async function runApprovedAction(approval: Approval): Promise<ApprovalActionOutcome> {
  const handler = handlers.get(approval.type);
  if (!handler) {
    // GENERIC approvals (and any type whose action isn't built yet) simply
    // record the decision. That's expected, not an error.
    return { ok: true };
  }

  try {
    const message = await handler(approval);
    return { ok: true, message };
  } catch (error) {
    logger.error("approval.action_failed", { approvalId: approval.id, type: approval.type, error: String(error) });
    await recordAudit({
      action: "approval.action_failed",
      entityType: "Approval",
      entityId: approval.id,
      actorType: "SYSTEM",
      details: { type: approval.type, error: String(error) },
    });
    return { ok: false, message: String(error) };
  }
}
