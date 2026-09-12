import { prisma } from "../../db/prisma.js";
import { logger } from "../../lib/logger.js";
import { getMonthToDateAiSpend, startOfMonthUtc } from "../../ai/budget.js";
import { isSupabaseConfigured, selectRows } from "./supabase.client.js";

export interface Stats {
  posts: { published: number; scheduled: number; failed: number; thisMonth: number };
  library: { assets: number; unused: number; knowledgeItems: number };
  spendUsd: number;
  /** Absent when Supabase isn't configured — distinct from zero. */
  audience?: { subscribers: number; newThisMonth: number };
  revenue?: { paidGbp: number; orders: number };
  /** Anything that couldn't be read, so a partial answer says what's missing. */
  unavailable: string[];
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export async function getStats(): Promise<Stats> {
  const monthStart = startOfMonthUtc();
  const unavailable: string[] = [];

  const [published, scheduled, failed, thisMonth, assets, knowledgeItems, spendUsd, unusedAssets] = await Promise.all([
    prisma.socialPost.count({ where: { status: "PUBLISHED" } }),
    prisma.socialPost.count({ where: { status: { in: ["SCHEDULED", "PUBLISHING"] } } }),
    prisma.socialPost.count({ where: { status: "FAILED" } }),
    prisma.socialPost.count({ where: { status: "PUBLISHED", publishedAt: { gte: monthStart } } }),
    prisma.asset.count(),
    prisma.knowledgeItem.count({ where: { isActive: true } }),
    getMonthToDateAiSpend(),
    prisma.asset.count({ where: { contentIdeas: { none: {} } } }),
  ]);

  const stats: Stats = {
    posts: { published, scheduled, failed, thisMonth },
    library: { assets, unused: unusedAssets, knowledgeItems },
    spendUsd,
    unavailable,
  };

  if (!isSupabaseConfigured()) {
    unavailable.push("Subscribers and sales — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Railway.");
    return stats;
  }

  try {
    const [all, recent] = await Promise.all([
      selectRows("newsletter_subscribers", { select: "id", limit: "1" }),
      selectRows("newsletter_subscribers", {
        select: "id",
        limit: "1",
        created_at: `gte.${monthStart.toISOString()}`,
      }),
    ]);
    stats.audience = { subscribers: all.total, newThisMonth: recent.total };
  } catch (error) {
    logger.error("analytics.subscribers_failed", { error: String(error) });
    unavailable.push("Subscriber numbers couldn't be read.");
  }

  try {
    // Only paid orders count as revenue — pending ones may never complete.
    const paid = await selectRows("purchases", { select: "amount_gbp", status: "eq.paid", limit: "1000" });
    const paidGbp = paid.rows.reduce((sum, row) => sum + (Number(row.amount_gbp) || 0), 0) / 100;
    stats.revenue = { paidGbp, orders: paid.total };
  } catch (error) {
    logger.error("analytics.revenue_failed", { error: String(error) });
    unavailable.push("Sales figures couldn't be read.");
  }

  return stats;
}

/** Renders the figures for Telegram, and for the agent to read as a tool result. */
export function formatStats(stats: Stats): string {
  const lines = [
    "HOW THINGS ARE GOING",
    "",
    "Posts",
    `• ${stats.posts.published} published (${stats.posts.thisMonth} this month)`,
    `• ${stats.posts.scheduled} scheduled`,
  ];
  if (stats.posts.failed > 0) lines.push(`• ${stats.posts.failed} failed — check /scheduled`);

  if (stats.audience) {
    lines.push(
      "",
      "Audience",
      `• ${stats.audience.subscribers} newsletter subscriber(s)`,
      `• ${stats.audience.newThisMonth} joined this month`,
    );
  }

  if (stats.revenue) {
    lines.push("", "Sales", `• £${stats.revenue.paidGbp.toFixed(2)} across ${stats.revenue.orders} paid order(s)`);
  }

  lines.push(
    "",
    "Your library",
    `• ${stats.library.assets} item(s), ${stats.library.unused} never used`,
    `• ${stats.library.knowledgeItems} fact(s) I know about you`,
    "",
    `AI cost this month: $${stats.spendUsd.toFixed(2)}`,
  );

  if (stats.unavailable.length > 0) {
    lines.push("", "Couldn't read:", ...stats.unavailable.map((item) => `• ${item}`));
  }

  // Said plainly, because the obvious question after seeing these is "how many
  // streams?" and the honest answer is that nothing here can tell him.
  lines.push(
    "",
    "Not included: Instagram reach and follower numbers (needs extra Meta permissions), and Spotify streams (no public API — use Spotify for Artists).",
  );

  return lines.join("\n");
}

export { isoDaysAgo };
