import { Router, type Request, type Response } from "express";
import { env } from "../config/env.js";
import { getMonthToDateAiSpend } from "../ai/budget.js";
import { getAsset } from "../modules/assets/asset.service.js";
import { storage } from "../storage/index.js";
import { verifyMediaSignature } from "../lib/signedMedia.js";
import { logger } from "../lib/logger.js";

export const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", dryRun: env.DRY_RUN });
});

function requireAdminKey(req: Request, res: Response): boolean {
  const key = req.header("x-admin-key");
  if (key !== env.ADMIN_API_KEY) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

/**
 * Serves one library asset to Instagram, which fetches media over the internet
 * rather than accepting uploaded bytes. Unauthenticated by necessity — Meta's
 * fetcher carries no credentials — so access is controlled by the signature and
 * expiry on the URL instead, and only images are ever served.
 */
router.get("/media/:assetId", async (req, res) => {
  const assetId = req.params.assetId!;
  const expires = Number(req.query.expires);
  const signature = typeof req.query.signature === "string" ? req.query.signature : "";

  if (!verifyMediaSignature(assetId, expires, signature)) {
    res.status(403).json({ error: "invalid or expired media link" });
    return;
  }

  const asset = await getAsset(assetId);
  if (!asset) {
    res.status(404).json({ error: "not found" });
    return;
  }
  // The library also holds contracts and audio; a signed link is not a reason
  // to hand those out, and Instagram only ever wants an image.
  if (!asset.mimeType?.startsWith("image/")) {
    res.status(415).json({ error: "not an image" });
    return;
  }

  try {
    const data = await storage.read(asset.storageKey);
    res.setHeader("content-type", asset.mimeType);
    res.setHeader("cache-control", "private, max-age=300");
    res.send(data);
  } catch (error) {
    logger.error("media.read_failed", { assetId, error: String(error) });
    res.status(404).json({ error: "not found" });
  }
});

router.get("/internal/ai-usage", async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const spend = await getMonthToDateAiSpend();
  res.json({ monthToDateEstimatedCostUsd: spend, budgetUsd: env.AI_MONTHLY_BUDGET_USD });
});
