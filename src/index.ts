import "dotenv/config";
import express from "express";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { router } from "./http/router.js";
import { createBot } from "./telegram/bot.js";
import { COMMANDS } from "./telegram/commands/trigger.js";
import { startScheduler, stopScheduler } from "./modules/social/scheduler.service.js";

async function main() {
  const app = express();
  app.use(express.json());
  app.use(router);

  const bot = createBot();

  // Publishes the command list to Telegram's menu so commands can be tapped
  // rather than typed — a typed command that gets autocapitalised by a phone
  // keyboard won't match its handler.
  await bot.telegram.setMyCommands(COMMANDS);

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
    await bot.telegram.deleteWebhook();
    bot.launch();
    logger.info("telegram.polling_started");
  }

  startScheduler();

  app.listen(env.PORT, () => {
    logger.info("http.listening", { port: env.PORT, dryRun: env.DRY_RUN });
  });

  process.once("SIGINT", () => {
    stopScheduler();
    bot.stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    stopScheduler();
    bot.stop("SIGTERM");
  });
}

main().catch((error) => {
  logger.error("fatal_startup_error", { error: String(error) });
  process.exit(1);
});
