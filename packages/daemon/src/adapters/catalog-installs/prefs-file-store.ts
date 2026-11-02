import { join } from 'node:path';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import {
  type CatalogInstallPrefsState,
  CatalogInstallPrefsStateSchema,
  type CatalogInstallPrefsStore,
  EMPTY_CATALOG_INSTALL_PREFS,
} from '../../lib/catalog-installs/prefs.ts';
import { CatalogInstallStateError } from '../../lib/catalog-installs/store.ts';

export const CATALOG_INSTALL_PREFS_DOCUMENT = 'catalog-install-prefs.json';

/**
 * `<FY_HOME>/state/catalog-install-prefs.json`, `0600` and written atomically like the installs file beside it.
 * DAMAGED IS NOT EMPTY: a file that will not parse raises, because answering "no preferences" and then writing
 * would forget every hold the person set. No part of the file reaches a message.
 */
export class FileCatalogInstallPrefsStore implements CatalogInstallPrefsStore {
  private readonly path: string;

  constructor(
    paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {
    this.path = join(paths.state, CATALOG_INSTALL_PREFS_DOCUMENT);
  }

  async read(): Promise<CatalogInstallPrefsState> {
    const raw = await this.files.readText(this.path);
    if (raw === undefined) return EMPTY_CATALOG_INSTALL_PREFS;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new CatalogInstallStateError(`${CATALOG_INSTALL_PREFS_DOCUMENT} is not JSON, so no preference was changed`);
    }
    const parsed = CatalogInstallPrefsStateSchema.safeParse(decoded);
    if (!parsed.success)
      throw new CatalogInstallStateError(
        `${CATALOG_INSTALL_PREFS_DOCUMENT} is not a record of preferences this daemon writes, so no preference was changed`,
      );
    return parsed.data;
  }

  async write(state: CatalogInstallPrefsState): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(state, undefined, 2)}\n`);
  }
}
