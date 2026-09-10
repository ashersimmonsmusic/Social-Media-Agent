import type { AssetStatus, AssetType, Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma.js";
import { recordAudit } from "../audit/audit.service.js";
import { storage } from "../../storage/index.js";
import { classifyContent } from "./ingestion.service.js";

export interface IngestFileInput {
  filename: string;
  mimeType?: string;
  data: Buffer;
  source?: string;
  description?: string;
}

export interface IngestTextInput {
  text: string;
  source?: string;
  description?: string;
}

/** Ingests a binary upload: classifies it, stores the bytes, creates the Asset row. */
export async function ingestFile(input: IngestFileInput) {
  const classification = classifyContent({ filename: input.filename, mimeType: input.mimeType });
  const stored = await storage.save({ filename: input.filename, data: input.data });

  const asset = await prisma.asset.create({
    data: {
      filename: input.filename,
      storageKey: stored.storageKey,
      mimeType: input.mimeType,
      assetType: classification.assetType,
      description: input.description,
      source: input.source,
      status: "UNPROCESSED",
      metadata: { sizeBytes: stored.size, classificationReason: classification.reason },
    },
  });

  await recordAudit({
    action: "asset.ingested",
    entityType: "Asset",
    entityId: asset.id,
    actorType: "AI",
    details: { filename: input.filename, assetType: classification.assetType, reason: classification.reason },
  });

  return asset;
}

/** Ingests a text/URL drop (pasted text, a quote, a forwarded link) — no binary storage needed. */
export async function ingestText(input: IngestTextInput) {
  const classification = classifyContent({ text: input.text });

  const asset = await prisma.asset.create({
    data: {
      filename: input.text.slice(0, 60),
      storageKey: "",
      assetType: classification.assetType,
      rawTextContent: input.text,
      sourceUrl: classification.assetType === "URL" ? input.text.trim() : undefined,
      description: input.description,
      source: input.source,
      status: "UNPROCESSED",
      metadata: { classificationReason: classification.reason },
    },
  });

  await recordAudit({
    action: "asset.ingested",
    entityType: "Asset",
    entityId: asset.id,
    actorType: "AI",
    details: { assetType: classification.assetType, reason: classification.reason },
  });

  return asset;
}

export async function getAsset(id: string) {
  return prisma.asset.findUnique({ where: { id } });
}

export async function listAssets(params: { assetType?: AssetType; status?: AssetStatus; tag?: string; limit?: number }) {
  const where: Prisma.AssetWhereInput = {
    assetType: params.assetType,
    status: params.status,
    tags: params.tag ? { has: params.tag } : undefined,
  };
  return prisma.asset.findMany({ where, orderBy: { createdAt: "desc" }, take: params.limit ?? 25 });
}

export async function searchAssets(query: string, limit = 25) {
  return prisma.asset.findMany({
    where: {
      OR: [
        { filename: { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } },
        { rawTextContent: { contains: query, mode: "insensitive" } },
        { tags: { has: query } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function tagAsset(id: string, tags: string[]) {
  const asset = await prisma.asset.update({ where: { id }, data: { tags: { set: tags } } });
  await recordAudit({ action: "asset.tagged", entityType: "Asset", entityId: id, actorType: "ASHER", details: { tags } });
  return asset;
}

export async function updateAssetStatus(id: string, status: AssetStatus) {
  const asset = await prisma.asset.update({ where: { id }, data: { status } });
  await recordAudit({ action: "asset.status_changed", entityType: "Asset", entityId: id, actorType: "SYSTEM", details: { status } });
  return asset;
}

/** Finds assets that have never been referenced by a ContentIdea — the "unused asset" list from brief §37. */
export async function listUnusedAssets(limit = 25) {
  return prisma.asset.findMany({
    where: { contentIdeas: { none: {} } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
