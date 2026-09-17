import "dotenv/config";
import express from "express";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { router } from "./http/router.js";
import { createBot } from "./telegram/bot.js";
import { COMMANDS } from "./telegram/commands/trigger.js";
import { startScheduler, stopScheduler } from "./modules/social/scheduler.service.js";
import { runPolling } from "./telegram/polling.js";
import { startDriveWatch, stopDriveWatch } from "./modules/drive/driveHealth.js";
import { startTokenRefresh, stopTokenRefresh } from "./modules/social/tokenRefresh.js";

async function main() {
  const app = express();
  app.use(express.json());
  app.use(router);

  const bot = createBot();

  // Publishes the command list to Telegram's menu so commands can be tapped
  // rather than typed — a typed command that gets autocapitalised by a phone
  // keyboard won't match its handler. Cosmetic, so a failure here is logged and
  // stepped over: it must never be the reason the bot doesn't run.
  try {
    await bot.telegram.setMyCommands(COMMANDS);
  } catch (error) {
    logger.warn("telegram.set_commands_failed", { error: String(error) });
  }

  if (env.TELEGRAM_USE_WEBHOOK) {
    if (!env.PUBLIC_BASE_URL) {
      throw new Error("PUBLIC_BASE_URL is required when TELEGRAM_USE_WEBHOOK=true");
    }
    const webhookPath = "/telegram/webhook";
    app.use(
      bot.webhookCallback(webhookPath, {
        secretToken: env.TELEGRAM_WEBHOOK_SECRET,
      }),
    );
    await bot.telegram.setWebhook(`${env.PUBLIC_BASE_URL}${webhookPath}`, {
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    });
    logger.info("telegram.webhook_set", { url: `${env.PUBLIC_BASE_URL}${webhookPath}` });
  } else {
    // launch() clears any existing webhook itself, so there's no separate
    // deleteWebhook call to fail on. Not awaited here because it only settles
    // when polling ends — but its rejection IS handled, which is the point.
    void runPolling(() => bot.launch()).catch((error) => {
      logger.error("telegram.polling_failed", { error: String(error) });
      process.exit(1);
    });
    logger.info("telegram.polling_started");
  }

  startScheduler();
  startDriveWatch(bot.telegram);
  startTokenRefresh();

  app.listen(env.PORT, () => {
    logger.info("http.listening", { port: env.PORT, dryRun: env.DRY_RUN });
  });

  process.once("SIGINT", () => {
    stopScheduler();
    stopDriveWatch();
    stopTokenRefresh();
    bot.stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    stopScheduler();
    stopDriveWatch();
    stopTokenRefresh();
    bot.stop("SIGTERM");
  });
}

// A promise that rejects with nothing attached to it terminates Node outright,
// and does it without printing anything — which is how a crash can look, in the
// logs, exactly like a healthy start. Never again: whatever dies, says so first.
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", { error: String(reason) });
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  logger.error("uncaught_exception", { error: String(error), stack: error.stack });
  process.exit(1);
});

main().catch((error) => {
  logger.error("fatal_startup_error", { error: String(error) });
  process.exit(1);
});
