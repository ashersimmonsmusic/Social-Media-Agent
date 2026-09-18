import { prisma } from "../../db/prisma.js";
import { logger } from "../../lib/logger.js";

/**
 * Named settings Asher changes from Telegram.
 *
 * Values are read through a parser rather than cast, because the row outlives
 * the code that wrote it: a shape that changed between deploys would otherwise
 * surface as an undefined property somewhere far from here. A row that no longer
 * parses is treated as absent and logged, which loses the setting rather than
 * the feature.
 */
export async function getSetting<T>(key: string, parse: (value: unknown) => T | null): Promise<T | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return null;

  try {
    const parsed = parse(row.value);
    if (parsed === null) logger.warn("setting.unreadable", { key });
    return parsed;
  } catch (error) {
    logger.warn("setting.parse_failed", { key, error: String(error) });
    return null;
  }
}

export async function setSetting(key: string, value: object): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

/** Returns true when there was something to clear, so a caller can say so. */
export async function clearSetting(key: string): Promise<boolean> {
  const { count } = await prisma.setting.deleteMany({ where: { key } });
  return count > 0;
}
