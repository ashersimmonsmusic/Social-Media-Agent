import { env } from "../config/env.js";
import { LocalStorageProvider } from "./LocalStorageProvider.js";
import type { StorageProvider } from "./types.js";

function buildStorageProvider(): StorageProvider {
  switch (env.STORAGE_DRIVER) {
    case "local":
      return new LocalStorageProvider(env.STORAGE_LOCAL_PATH);
    default:
      throw new Error(`Unsupported STORAGE_DRIVER: ${env.STORAGE_DRIVER}`);
  }
}

export const storage: StorageProvider = buildStorageProvider();
export type { StorageProvider } from "./types.js";
