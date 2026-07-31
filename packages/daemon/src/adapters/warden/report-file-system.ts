import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
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

    const entries = await Promise.all(
      names.map(async name => {
        const path = join(directory, name);
        try {
          const details = await stat(path);
          // A nested directory is not a report, and stat-ing it must not make
          // it look like one.
          return details.isFile() ? { path, mtimeMs: details.mtimeMs } : undefined;
        } catch (error) {
          // The sweep that wrote the listing races the one that prunes it.
          if (isMissing(error)) return undefined;
          throw error;
        }
      }),
    );
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
}
