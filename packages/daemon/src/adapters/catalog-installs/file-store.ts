import { join } from 'node:path';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import {
  CatalogInstallStateError,
  type CatalogInstallState,
  CatalogInstallStateSchema,
  type CatalogInstallStore,
  EMPTY_CATALOG_INSTALL_STATE,
} from '../../lib/catalog-installs/store.ts';

export const CATALOG_INSTALLS_DOCUMENT = 'catalog-installs.json';

const CATALOG_INSTALLS_MODE = 0o600;

/**
 * `<FY_HOME>/state/catalog-installs.json`, `0600`, written by temp + rename. DAMAGED IS NOT EMPTY: a file that
 * will not parse raises, because answering "no installs" would forget every pin and every hash. Only a
 * state home that never installed anything answers the empty state. No part of the file reaches a message.
 */
export class FileCatalogInstallStore implements CatalogInstallStore {
  private readonly path: string;

  constructor(
    paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {
    this.path = join(paths.state, CATALOG_INSTALLS_DOCUMENT);
  }

  async read(): Promise<CatalogInstallState> {
    const raw = await this.files.readText(this.path);
    if (raw === undefined) return EMPTY_CATALOG_INSTALL_STATE;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new CatalogInstallStateError(`${CATALOG_INSTALLS_DOCUMENT} is not JSON, so no install was changed`);
    }
    const parsed = CatalogInstallStateSchema.safeParse(decoded);
    if (!parsed.success)
      throw new CatalogInstallStateError(
        `${CATALOG_INSTALLS_DOCUMENT} is not a record of installs this daemon writes, so no install was changed`,
      );
    return parsed.data;
  }

  async write(state: CatalogInstallState): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(state, undefined, 2)}\n`);
    await this.files.setMode(this.path, CATALOG_INSTALLS_MODE);
  }
}
