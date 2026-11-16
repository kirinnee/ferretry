/**
 * THE ONE READ A LIST OF ROWS SHARES. Every skill (or MCP) row says where its item stands in catalogs, and that is the same
 * two lists for all of them: the installs this machine recorded and this machine's own catalogs. A row that read them
 * itself would ask the daemon twice per row; a store is read once, when its first row appears, again on `reload` (a
 * Publish or an Uninstall on any row), and handed to every row that subscribes.
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

/** A store that reads when its first subscriber arrives. A late answer to an older read is dropped. */
export function createCatalogRowsStore(read: () => Promise<CatalogRowsSnapshot>): CatalogRowsStore {
  let snapshot = NOTHING_READ;
  let started = false;
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
      listeners.add(listener);
      if (!started) {
        started = true;
        reload();
      }
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => snapshot,
    reload,
  };
}
