import { join } from 'node:path';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import {
  CATALOG_INSTALLS_SCHEMA_VERSION,
  CATALOG_INSTALLS_SCHEMA_VERSION_LINKS,
  CatalogInstallStateError,
  type CatalogInstallState,
  CatalogInstallStateSchema,
  type CatalogInstallStore,
  EMPTY_CATALOG_INSTALL_STATE,
} from '../../lib/catalog-installs/store.ts';

export const CATALOG_INSTALLS_DOCUMENT = 'catalog-installs.json';
/** The exact text of the version 1 file, kept when the first link install upgrades it. */
export const CATALOG_INSTALLS_V1_BACKUP = 'catalog-installs.v1.json';

const isVersion1 = (text: string): boolean => {
  try {
    return (JSON.parse(text) as { schemaVersion?: unknown }).schemaVersion === CATALOG_INSTALLS_SCHEMA_VERSION;
  } catch {
    return false;
  }
};

/**
 * `<FY_HOME>/state/catalog-installs.json`, `0600` from the first byte: the port opens its temporary file with mode `0600` and renames it into place, so the file is never wider than that, even for an instant. DAMAGED IS NOT EMPTY: a file that
 * will not parse raises, because answering "no installs" would forget every pin and every hash. Only a
 * state home that never installed anything answers the empty state. No part of the file reaches a message.
 */
export class FileCatalogInstallStore implements CatalogInstallStore {
  private readonly path: string;
  private readonly backupPath: string;

  constructor(
    paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {
    this.path = join(paths.state, CATALOG_INSTALLS_DOCUMENT);
    this.backupPath = join(paths.state, CATALOG_INSTALLS_V1_BACKUP);
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

  /**
   * Writing version 2 over a version 1 file is the upgrade, and the only place it happens: the exact old text is kept
   * as `catalog-installs.v1.json` first, so going back is a rename (and loses what was installed since).
   */
  async write(state: CatalogInstallState): Promise<void> {
    if (state.schemaVersion === CATALOG_INSTALLS_SCHEMA_VERSION_LINKS) {
      const previous = await this.files.readText(this.path);
      if (previous !== undefined && isVersion1(previous)) await this.files.writeTextAtomic(this.backupPath, previous);
    }
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(state, undefined, 2)}\n`);
  }
}
