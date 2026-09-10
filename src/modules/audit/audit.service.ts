import { prisma } from "../../db/prisma.js";
import { logger } from "../../lib/logger.js";
import type { AuditActorType } from "@prisma/client";

export interface RecordAuditInput {
  action: string;
  entityType: string;
  entityId?: string;
  actorType: AuditActorType;
  actorId?: string;
  details?: Record<string, unknown>;
}

/**
 * Every important/external action gets an append-only AuditLog row.
 * This is deliberately the only way modules write audit history, so the
 * log can never be partially skipped by a call site forgetting a field.
 */
export async function recordAudit(input: RecordAuditInput) {
  const entry = await prisma.auditLog.create({
    data: {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      actorType: input.actorType,
      actorId: input.actorId,
      details: (input.details ?? {}) as never,
    },
  });
  logger.info("audit", { action: input.action, entityType: input.entityType, entityId: input.entityId });
  return entry;
}

export async function searchAuditLog(params: { entityType?: string; entityId?: string; action?: string; limit?: number }) {
  return prisma.auditLog.findMany({
    where: {
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action ? { contains: params.action, mode: "insensitive" } : undefined,
    },
    orderBy: { createdAt: "desc" },
    take: params.limit ?? 50,
  });
}
