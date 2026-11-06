import { join } from 'node:path';
import type { LegacyLimitsPorts } from '../../lib/cgroups/index.ts';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';

const DIRECTORY = 'cgroups';

/**
 * The retired `cgroups/config.json` (and the apply record beside it), read and put away.
 *
 * "Put away" is a copy to `config.json.migrated` and then a removal: the confined filesystem port has no
 * rename, and copying first means an interrupted retirement leaves the original in place for the next
 * start to finish.
 */
export class FileLegacyCgroupDocuments implements Pick<LegacyLimitsPorts, 'readOld' | 'retireOld'> {
  private readonly config: string;
  private readonly migrated: string;
  private readonly applyStatus: string;

  constructor(
    private readonly files: FileSystemPort,
    paths: FoundationPaths,
  ) {
    this.config = join(paths.home, DIRECTORY, 'config.json');
    this.migrated = join(paths.home, DIRECTORY, 'config.json.migrated');
    this.applyStatus = join(paths.home, DIRECTORY, 'apply-status.json');
  }

  async readOld(): Promise<unknown> {
    const text = await this.files.readText(this.config).catch(() => undefined);
    if (text === undefined || text.trim() === '') return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async retireOld(): Promise<void> {
    const text = await this.files.readText(this.config).catch(() => undefined);
    if (text === undefined) return;
    await this.files.writeTextAtomic(this.migrated, text);
    await this.files.removeFile(this.config);
    await this.files.removeFile(this.applyStatus).catch(() => undefined);
  }
}
