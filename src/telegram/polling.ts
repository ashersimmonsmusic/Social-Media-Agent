import { logger } from "../lib/logger.js";

/**
 * Telegram allows exactly one long-poll consumer per bot token, and answers a
 * second one with 409 Conflict. Every deploy creates one for a few seconds: the
 * replacement container starts polling while the outgoing one is still going.
 *
 * Telegraf throws that 409 out of the polling loop rather than retrying it, so
 * the old container going away is all that is needed — wait for it instead of
 * dying, since the alternative is a crash the platform restarts straight back
 * into the same conflict.
 */
export const CONFLICT_RETRY_MS = 5_000;
export const CONFLICT_MAX_WAIT_MS = 3 * 60 * 1000;

export function isPollingConflict(error: unknown): boolean {
  const err = error as { code?: number; response?: { error_code?: number } } | null;
  return err?.code === 409 || err?.response?.error_code === 409;
}

export interface PollingOptions {
  retryMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs long polling and returns the promise for it, retrying only the conflict
 * a deploy causes.
 *
 * A bare `bot.launch()` returns a promise nobody holds. When polling fails, that
 * promise rejects with no handler, Node terminates the process, and nothing is
 * printed — so the logs end on a healthy-looking line and the crash has no
 * visible cause. Holding it is the whole point of this function.
 */
export async function runPolling(launch: () => Promise<void>, options: PollingOptions = {}): Promise<void> {
  const retryMs = options.retryMs ?? CONFLICT_RETRY_MS;
  const maxWaitMs = options.maxWaitMs ?? CONFLICT_MAX_WAIT_MS;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;

  const giveUpAt = now() + maxWaitMs;

  for (;;) {
    try {
      // Resolves only when polling stops, so reaching here is a deliberate
      // shutdown rather than a normal return.
      await launch();
      logger.info("telegram.polling_stopped");
      return;
    } catch (error) {
      if (!isPollingConflict(error)) throw error;

      if (now() >= giveUpAt) {
        throw new Error(
          `Another instance of this bot has been polling Telegram for ${Math.round(maxWaitMs / 60000)} minutes. ` +
            "Check for a second deployment, or a copy running somewhere else on the same token.",
        );
      }
      logger.warn("telegram.polling_conflict", { retryInMs: retryMs });
      await sleep(retryMs);
    }
  }
}
