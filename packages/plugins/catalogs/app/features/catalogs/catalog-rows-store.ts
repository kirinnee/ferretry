/**
 * THE ONE READ A LIST OF ROWS SHARES. Every skill (or MCP) row says where its item stands in catalogs, and that is the same
 * two lists for all of them: the installs this machine recorded and this machine's own catalogs. A row that read them
 * itself would ask the daemon twice per row; a store is read once, when its first row appears (again each time a list
 * is mounted afresh), again on `reload` (a Publish or an Uninstall on any row), and handed to every row that subscribes.
 *
 * A read that fails shows nothing: the row is still right, so each list falls back to empty on its own.
 */

import type { CatalogInstall, OwnedCatalog } from '../../../contract/wire/index.ts';
import type { CatalogClient } from '../../lib/catalog-client.ts';
import { listCatalogInstalls } from './catalog-installs-api.ts';
import { listCatalogs } from './catalogs-api.ts';

export interface CatalogRowsSnapshot {
  readonly installs: readonly CatalogInstall[];
  readonly catalogs: readonly OwnedCatalog[];
  /** The catalog one tap adds to, when the machine has made one. */
  readonly defaultCatalogId?: string;
}

const NO_INSTALLS: readonly CatalogInstall[] = [];
const NO_CATALOGS: readonly OwnedCatalog[] = [];
const NOTHING_READ: CatalogRowsSnapshot = { installs: NO_INSTALLS, catalogs: NO_CATALOGS };

/** Both lists of one machine, each empty when it cannot be read. `open` is how the client is reached. */
export async function readCatalogRows(open: () => Promise<CatalogClient>): Promise<CatalogRowsSnapshot> {
  const [installs, catalogs] = await Promise.all([
    open()
      .then(async api => await listCatalogInstalls(api))
      .then(list => list.installs)
      .catch(() => NO_INSTALLS),
    open()
      .then(async api => await listCatalogs(api))
      .catch(() => undefined),
  ]);
  return {
    installs,
    catalogs: catalogs?.catalogs ?? NO_CATALOGS,
    ...(catalogs?.defaultCatalogId === undefined ? {} : { defaultCatalogId: catalogs.defaultCatalogId }),
  };
}

/** The shape `useSyncExternalStore` takes, plus the reload every row's Publish and Uninstall asks for. */
export interface CatalogRowsStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly get: () => CatalogRowsSnapshot;
  readonly reload: () => void;
}

/**
 * A store that reads each time a list of rows is MOUNTED, when its first subscriber arrives (the rows that follow in
 * the same list share that read), and forgets what it read when the last one leaves: the store outlives the Skills
 * panel, and a list opened again must not show what an install or an uninstall made untrue while it was away. A late
 * answer to an older read is dropped, including one that comes back after the list left.
 */
export function createCatalogRowsStore(read: () => Promise<CatalogRowsSnapshot>): CatalogRowsStore {
  let snapshot = NOTHING_READ;
  let generation = 0;
  const listeners = new Set<() => void>();
  const reload = (): void => {
    generation += 1;
    const mine = generation;
    void read().then(next => {
      if (mine !== generation) return;
      snapshot = next;
      for (const listener of listeners) listener();
    });
  };
  return {
    subscribe: listener => {
      const first = listeners.size === 0;
      listeners.add(listener);
      if (first) reload();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        generation += 1;
        snapshot = NOTHING_READ;
      };
    },
    get: () => snapshot,
    reload,
  };
}
