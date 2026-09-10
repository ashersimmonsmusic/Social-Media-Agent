import { prisma } from "../../db/prisma.js";
import { recordAudit } from "../audit/audit.service.js";

export async function createContentIdea(input: { title: string; description?: string; pillar?: string; sourceAssetId?: string }) {
  const idea = await prisma.contentIdea.create({ data: input });
  await recordAudit({ action: "idea.created", entityType: "ContentIdea", entityId: idea.id, actorType: "AI", details: input });
  return idea;
}

export async function listContentIdeas(params: { status?: "NEW" | "DRAFTED" | "USED" | "DISCARDED"; pillar?: string; limit?: number }) {
  return prisma.contentIdea.findMany({
    where: { status: params.status, pillar: params.pillar },
    orderBy: { createdAt: "desc" },
    take: params.limit ?? 25,
  });
}
