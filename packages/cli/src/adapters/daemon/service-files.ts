import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { IServiceFilePort } from '../../lib/daemon/ports.ts';

/**
 * The service definition and log directory on disk.
 *
 * Definitions are written owner-only: they carry the daemon's `PATH` and state home, and a service
 * manager reads them as the invoking user, so nobody else needs them.
 */
export class FileServiceStore implements IServiceFilePort {
  async exists(path: string): Promise<boolean> {
    return await Bun.file(path).exists();
  }

  async writePrivate(path: string, contents: string): Promise<void> {
    await writeFile(path, contents, { mode: 0o600 });
  }

  async remove(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  async ensureDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }
}
