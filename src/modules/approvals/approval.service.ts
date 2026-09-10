import type { ApprovalLevel, ApprovalStatus, ApprovalType } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { recordAudit } from "../audit/audit.service.js";

export type ApprovalAction = "APPROVE" | "EDIT" | "REGENERATE" | "SCHEDULE" | "REJECT" | "SEND" | "DONT_SEND" | "CONFIRM" | "CANCEL";

export interface ApprovalPayload {
  title: string;
  summary: string;
  fields?: Record<string, string>;
  /** Which buttons the Telegram renderer should show, in order. */
  actions: ApprovalAction[];
  /** Key into `fields` that an EDIT button replaces with Asher's next text reply. */
  editableField?: string;
  /** What REGENERATE re-runs, if this payload supports it. */
  regenerate?: { taskType: string; prompt: string; targetField: string };
}

export interface CreateApprovalInput {
  type?: ApprovalType;
  level: ApprovalLevel;
  payload: ApprovalPayload;
}

export async function createApproval(input: CreateApprovalInput) {
  const approval = await prisma.approval.create({
    data: {
      type: input.type ?? "GENERIC",
      level: input.level,
      payload: input.payload as never,
      status: "PENDING",
    },
  });
  await recordAudit({
    action: "approval.requested",
    entityType: "Approval",
    entityId: approval.id,
    actorType: "AI",
    details: { type: approval.type, level: approval.level, title: input.payload.title },
  });
  return approval;
}

export async function attachTelegramMessage(approvalId: string, telegramChatId: string, telegramMessageId: string) {
  return prisma.approval.update({
    where: { id: approvalId },
    data: { telegramChatId, telegramMessageId },
  });
}

export async function updateApprovalPayload(id: string, payload: ApprovalPayload) {
  return prisma.approval.update({ where: { id }, data: { payload: payload as never } });
}

export async function getApproval(id: string) {
  return prisma.approval.findUnique({ where: { id } });
}

export async function listPendingApprovals(limit = 25) {
  return prisma.approval.findMany({ where: { status: "PENDING" }, orderBy: { requestedAt: "asc" }, take: limit });
}

/**
 * The ONLY function that resolves an Approval. It must always be called
 * from an explicit button press against this specific Approval's message
 * (see telegram/callbacks.ts) — never from free-text interpretation of a
 * chat message, at any approval level (brief §2's "never infer approval").
 */
export async function resolveApproval(id: string, status: Exclude<ApprovalStatus, "PENDING">, resolvedBy: string) {
  const approval = await prisma.approval.update({
    where: { id },
    data: { status, resolvedAt: new Date(), resolvedBy },
  });
  await recordAudit({
    action: `approval.${status.toLowerCase()}`,
    entityType: "Approval",
    entityId: approval.id,
    actorType: "ASHER",
    actorId: resolvedBy,
    details: { type: approval.type, level: approval.level },
  });
  return approval;
}
