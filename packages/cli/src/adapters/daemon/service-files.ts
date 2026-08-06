import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IServiceFilePort } from '../../lib/daemon/ports.ts';

export interface FileServiceStoreOptions {
  /** Observation seam for deterministic publication tests; production leaves it absent. */
  readonly afterStagedSync?: ((stagedPath: string, targetPath: string) => Promise<void>) | undefined;
}

/**
 * The service definition and log directory on disk.
 *
 * Definitions are written owner-only: they carry the daemon's `PATH` and state home, and a service
 * manager reads them as the invoking user, so nobody else needs them.
 */
export class FileServiceStore implements IServiceFilePort {
  constructor(private readonly options: FileServiceStoreOptions = {}) {}

  async exists(path: string): Promise<boolean> {
    return await Bun.file(path).exists();
  }

  /**
   * Publish the definition whole, or leave whatever was there untouched.
   *
   * A plain write truncates first, so a crash in the middle leaves a half-written unit or plist that
   * the service manager rejects — and `install` is the only verb that would ever rewrite it, so the
   * host stays broken until somebody runs it again. Written to a private name in the SAME directory,
   * persisted, then renamed onto the target: a reader sees the old complete file or the new complete
   * one. The parent directory is persisted afterwards so the rename itself survives a power loss, and
   * a failed publication removes its own temporary rather than leaving debris beside a unit file.
   */
  async writePrivate(path: string, contents: string): Promise<void> {
    const directory = dirname(path);
    const staged = join(directory, `.${randomUUID()}.tmp`);
    try {
      const file = await open(staged, 'wx', 0o600);
      try {
        await file.writeFile(contents, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await this.options.afterStagedSync?.(staged, path);
      await rename(staged, path);
    } finally {
      await rm(staged, { force: true }).catch(() => undefined);
    }
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
}
