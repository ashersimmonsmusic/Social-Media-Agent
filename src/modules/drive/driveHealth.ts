import type { Telegram } from "telegraf";
import { logger } from "../../lib/logger.js";
import { sendPlainMessage } from "../../telegram/notify.js";
import { getAccessToken, getConnection, GoogleReauthRequiredError } from "../oauth/google.service.js";

/**
 * Google expires the whole authorisation seven days after consent while an
 * OAuth app is still marked "Testing", and publishing it means hosting a
 * privacy policy on a verified domain and passing review for a restricted
 * scope — disproportionate for one person reading their own Drive.
 *
 * So the lapse is accepted and managed instead. Checking four times a day
 * catches it within hours, which means Asher hears it from the bot rather than
 * finding out when he asks for a clip and gets nothing.
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Whether the last check found the connection broken. Stops the same warning
 * arriving four times a day until he gets round to it — the point is to tell
 * him once, not to nag.
 */
let warned = false;

export async function checkDriveAccess(telegram: Telegram): Promise<"ok" | "lapsed" | "not-connected"> {
  const connection = await getConnection();
  if (!connection) return "not-connected";

  try {
    // Refreshes if the access token is stale, which is the actual test: a dead
    // refresh token fails exactly here and nowhere earlier.
    await getAccessToken();
    if (warned) {
      warned = false;
      logger.info("drive.access_restored");
    }
    return "ok";
  } catch (error) {
    if (!(error instanceof GoogleReauthRequiredError)) {
      // A network blip is not a lapsed permission; saying so would train him to
      // ignore the message that matters.
      logger.warn("drive.health_check_failed", { error: String(error) });
      return "ok";
    }

    if (!warned) {
      warned = true;
      logger.info("drive.access_lapsed");
      await sendPlainMessage(
        telegram,
        "Heads up — Google has expired my access to your Drive. It does this every 7 days while your " +
          "Google app is set to \"Testing\".\n\nRun /drive and approve again; it takes a few seconds. " +
          "I can't see your videos until you do.",
      );
    }
    return "lapsed";
  }
}

let timer: NodeJS.Timeout | null = null;

export function startDriveWatch(telegram: Telegram, intervalMs = CHECK_INTERVAL_MS) {
  if (timer) return;
  timer = setInterval(() => {
    void checkDriveAccess(telegram).catch((error) => logger.error("drive.watch_tick_failed", { error: String(error) }));
  }, intervalMs);
  timer.unref?.();
  logger.info("drive.watch_started", { intervalMs });
}

export function stopDriveWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Exposed so a test can start from a known state. */
export function resetDriveWarning() {
  warned = false;
}
