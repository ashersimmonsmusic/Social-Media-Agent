import type { Telegram } from "telegraf";

/** Downloads a Telegram-hosted file (by file_id) into memory. */
export async function downloadTelegramFile(telegram: Telegram, fileId: string): Promise<Buffer> {
  const link = await telegram.getFileLink(fileId);
  const response = await fetch(link.toString());
  if (!response.ok) {
    throw new Error(`Failed to download Telegram file (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
