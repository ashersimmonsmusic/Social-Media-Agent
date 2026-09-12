import { Router, type Request, type Response } from "express";
import { env } from "../config/env.js";
import { getMonthToDateAiSpend } from "../ai/budget.js";
import { getAsset } from "../modules/assets/asset.service.js";
import { storage } from "../storage/index.js";
import { verifyMediaSignature } from "../lib/signedMedia.js";
import { completeConnection, verifyState } from "../modules/oauth/google.service.js";
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

/**
 * Where Google sends Asher back after he approves access. Public by necessity —
 * Google redirects a browser here — so the signed, short-lived `state` is what
 * proves the flow began in his own chat rather than from someone hitting the URL.
 */
router.get("/oauth/google/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const error = typeof req.query.error === "string" ? req.query.error : "";

  if (error) {
    res.status(400).send(`Google reported: ${error}. Nothing was connected.`);
    return;
  }
  if (!code || !verifyState(state)) {
    res.status(403).send("That link is invalid or has expired. Run /drive in Telegram for a fresh one.");
    return;
  }

  try {
    const account = await completeConnection(code);
    res.send(
      `Google Drive connected${account.accountEmail ? ` as ${account.accountEmail}` : ""}. ` +
        `You can close this tab and go back to Telegram.`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("oauth.google_callback_failed", { error: detail });
    res.status(500).send(`Couldn't finish connecting: ${detail}`);
  }
});

router.get("/internal/ai-usage", async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const spend = await getMonthToDateAiSpend();
  res.json({ monthToDateEstimatedCostUsd: spend, budgetUsd: env.AI_MONTHLY_BUDGET_USD });
});
