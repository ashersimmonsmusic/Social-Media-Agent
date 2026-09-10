import { Router, type Request, type Response } from "express";
import { env } from "../config/env.js";
import { getMonthToDateAiSpend } from "../ai/budget.js";

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

router.get("/internal/ai-usage", async (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const spend = await getMonthToDateAiSpend();
  res.json({ monthToDateEstimatedCostUsd: spend, budgetUsd: env.AI_MONTHLY_BUDGET_USD });
});
