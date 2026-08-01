import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mapWithConcurrency } from './concurrent.ts';
import type { WardenFileInfo, WardenReportFileSystem } from '../../lib/warden/index.ts';

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/** Reports live on the local filesystem; a path that does not exist yet reads
 *  as empty rather than as a failure. */
export class NodeWardenReportFileSystem implements WardenReportFileSystem {
  async listFiles(directory: string): Promise<readonly WardenFileInfo[]> {
    let names: readonly string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }

    const entries = await mapWithConcurrency(names, async name => {
      const path = join(directory, name);
      try {
        const details = await stat(path);
        // A nested directory is not a report, and stat-ing it must not make it
        // look like one.
        return details.isFile() ? { path, mtimeMs: details.mtimeMs } : undefined;
      } catch {
        // Skip, never throw. The entry may have been pruned by a concurrent
        // sweep, or the host may be out of descriptors — and an entry we cannot
        // stat is one we could not have read either. Failing the whole listing
        // over one of them would blank the verdict list, which is precisely the
        // surface a struggling host needs to keep showing.
        return undefined;
      }
    });
    return entries.filter((entry): entry is WardenFileInfo => entry !== undefined);
  }

  async readText(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  async writeTextAtomic(path: string, text: string): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      // A failed atomic replace must not leave a report-shaped temporary file
      // among the evidence a later sweep lists.
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
