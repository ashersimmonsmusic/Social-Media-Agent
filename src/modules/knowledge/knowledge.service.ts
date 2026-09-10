import type { KnowledgeCategory, KnowledgeConfidence, KnowledgeSourceType } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { recordAudit } from "../audit/audit.service.js";

export interface KnowledgeDraft {
  category: KnowledgeCategory;
  title: string;
  content: string;
}

export async function storeKnowledgeItems(
  drafts: KnowledgeDraft[],
  source: { sourceType: KnowledgeSourceType; sourceUrl?: string; sourceDetail?: string },
  confidence: KnowledgeConfidence,
) {
  const created = await prisma.$transaction(
    drafts.map((draft) =>
      prisma.knowledgeItem.create({
        data: {
          category: draft.category,
          title: draft.title,
          content: draft.content,
          confidence,
          sourceType: source.sourceType,
          sourceUrl: source.sourceUrl,
          sourceDetail: source.sourceDetail,
        },
      }),
    ),
  );

  await recordAudit({
    action: "knowledge.imported",
    entityType: "KnowledgeItem",
    actorType: "ASHER",
    details: { count: created.length, sourceUrl: source.sourceUrl, confidence },
  });

  return created;
}

export async function listKnowledge(params: { category?: KnowledgeCategory; limit?: number } = {}) {
  return prisma.knowledgeItem.findMany({
    where: { isActive: true, category: params.category },
    orderBy: [{ category: "asc" }, { createdAt: "desc" }],
    take: params.limit ?? 50,
  });
}

export async function searchKnowledge(query: string, limit = 25) {
  return prisma.knowledgeItem.findMany({
    where: {
      isActive: true,
      OR: [
        { title: { contains: query, mode: "insensitive" } },
        { content: { contains: query, mode: "insensitive" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function countKnowledge() {
  return prisma.knowledgeItem.count({ where: { isActive: true } });
}
