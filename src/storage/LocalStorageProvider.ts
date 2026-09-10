import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StorageProvider, StoredFileRef } from "./types.js";

export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly basePath: string) {}

  private absolutePath(storageKey: string): string {
    return path.join(this.basePath, storageKey);
  }

  async save(params: { filename: string; data: Buffer }): Promise<StoredFileRef> {
    await mkdir(this.basePath, { recursive: true });
    const ext = path.extname(params.filename);
    const storageKey = `${randomUUID()}${ext}`;
    await writeFile(this.absolutePath(storageKey), params.data);
    return { storageKey, size: params.data.byteLength };
  }

  async read(storageKey: string): Promise<Buffer> {
    return readFile(this.absolutePath(storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    await rm(this.absolutePath(storageKey), { force: true });
  }

  urlFor(_storageKey: string): string | null {
    // Local disk has no public URL in Phase 1 — files are only accessed
    // server-side (e.g. to send back to Telegram). A future S3/R2 provider
    // returns a real URL here.
    return null;
  }
}
