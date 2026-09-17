import { prisma } from "../../db/prisma.js";
import { logger } from "../../lib/logger.js";
import { decryptToken, encryptToken } from "../../lib/tokenCrypto.js";
import { refreshLongLivedToken } from "../oauth/instagramLogin.service.js";

/**
 * Keeps the Instagram Login token alive.
 *
 * It lasts sixty days and renews without anyone present, so the expiry should
 * never reach Asher — but only if something actually asks. Renewed with plenty
 * of margin because a token that lapses needs him to log in again, which is the
 * exact thing this whole path was chosen to avoid.
 */
const RENEW_WHEN_DAYS_LEFT = 10;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export async function refreshDueTokens(): Promise<number> {
  const accounts = await prisma.socialAccount.findMany({
    where: { isActive: true, authType: "INSTAGRAM_LOGIN" },
  });

  let renewed = 0;
  for (const account of accounts) {
    const daysLeft = account.tokenExpiresAt
      ? (account.tokenExpiresAt.getTime() - Date.now()) / 86_400_000
      : 0;
    if (account.tokenExpiresAt && daysLeft > RENEW_WHEN_DAYS_LEFT) continue;

    try {
      const { token, expiresAt } = await refreshLongLivedToken(decryptToken(account.accessToken));
      await prisma.socialAccount.update({
        where: { id: account.id },
        data: { accessToken: encryptToken(token), tokenExpiresAt: expiresAt },
      });
      renewed += 1;
      logger.info("social.token_renewed", { accountId: account.id, expiresAt: expiresAt.toISOString() });
    } catch (error) {
      // Logged rather than surfaced: there are days of margin left, and the next
      // pass will try again. It only becomes Asher's problem if it keeps failing,
      // and /ready reports the token as dead when that happens.
      logger.error("social.token_renew_failed", { accountId: account.id, error: String(error) });
    }
  }
  return renewed;
}

let timer: NodeJS.Timeout | null = null;

export function startTokenRefresh(intervalMs = CHECK_INTERVAL_MS) {
  if (timer) return;
  // Once at startup, so a container that was down over the renewal window
  // catches up rather than waiting half a day.
  void refreshDueTokens().catch((error) => logger.error("social.token_refresh_failed", { error: String(error) }));
  timer = setInterval(() => {
    void refreshDueTokens().catch((error) => logger.error("social.token_refresh_failed", { error: String(error) }));
  }, intervalMs);
  timer.unref?.();
  logger.info("social.token_refresh_started", { intervalMs });
}

export function stopTokenRefresh() {
  if (timer) clearInterval(timer);
  timer = null;
}
