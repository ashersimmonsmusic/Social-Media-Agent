import { Telegraf } from "telegraf";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { recordAudit } from "../modules/audit/audit.service.js";
import { registerStartCommand } from "./commands/start.js";
import { registerWhatsImportantCommand } from "./commands/whatsImportant.js";
import { registerLibraryCommand } from "./commands/library.js";
import { registerBrandCommand } from "./commands/brand.js";
import { registerCaptionCommand } from "./commands/caption.js";
import { registerLearnCommand } from "./commands/learn.js";
import { registerUploadHandlers } from "./handlers/uploads.js";
import { registerTextHandler } from "./handlers/text.js";
import { registerApprovalCallbacks } from "./callbacks.js";

export function createBot(): Telegraf {
  const bot = new Telegraf(env.TELEGRAM_BOT_TOKEN);

  // The entire authentication model for Phase 1: only Asher's chat is ever
  // acted on. Every other chat is logged and dropped (brief §7 security).
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id !== undefined ? String(ctx.chat.id) : undefined;
    if (chatId !== env.TELEGRAM_ALLOWED_CHAT_ID) {
      logger.warn("telegram.blocked_chat", { chatId });
      await recordAudit({
        action: "telegram.unauthorized_message",
        entityType: "TelegramChat",
        entityId: chatId,
        actorType: "SYSTEM",
      });
      return; // do not call next() — message is dropped entirely
    }
    return next();
  });

  registerStartCommand(bot);
  registerWhatsImportantCommand(bot);
  registerLibraryCommand(bot);
  registerBrandCommand(bot);
  registerCaptionCommand(bot);
  registerLearnCommand(bot);
  registerApprovalCallbacks(bot);

  // Upload/text handlers must be registered last so command handlers match first.
  registerUploadHandlers(bot);
  registerTextHandler(bot);

  bot.catch((error, ctx) => {
    logger.error("telegram.unhandled_error", { error: String(error), updateType: ctx.updateType });
  });

  return bot;
}
