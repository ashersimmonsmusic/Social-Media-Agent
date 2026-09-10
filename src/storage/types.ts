export interface StoredFileRef {
  /** Opaque key the provider uses to locate the file again. */
  storageKey: string;
  /** Number of bytes written. */
  size: number;
}

/**
 * Every storage backend (local disk, S3, R2, ...) implements this. Modules
 * depend only on this interface, never on a concrete provider, so swapping
 * backends later (Phase 2+) doesn't touch calling code.
 */
export interface StorageProvider {
  save(params: { filename: string; data: Buffer }): Promise<StoredFileRef>;
  read(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
  urlFor(storageKey: string): string | null;
}
