/**
 * What the Skills and MCP lists read once so every row can say where its item stands in catalogs: the
 * installs this machine recorded (matched to a row by kind and name) and this machine's own catalogs
 * (matched by source). A read that fails shows nothing: the row is still right. The row itself is
 * `catalog-item-row.tsx`.
 */

import type { CatalogInstall, OwnedCatalog } from '../../../contract/wire/index.ts';
import { useMemo, useState, useSyncExternalStore } from 'react';
import type { DaemonConnection } from '../../lib/machine.ts';
import { useDaemonClient } from '../../lib/client-context.tsx';
import { AddCatalogFromLink } from './add-from-link.tsx';
import { type CatalogRowsStore, createCatalogRowsStore, readCatalogRows } from './catalog-rows-store.ts';
import { CatalogMoreMenu } from './catalog-more-menu.tsx';
import { type CatalogClientFactory, type CatalogFeatures, ALL_CATALOG_FEATURES } from './catalogs-api.ts';
import { InstallFromFileSheet } from './install-from-file-sheet.tsx';

/** Which machine the rows belong to. `createClient` is a test and harness seam. */
export interface CatalogRowsHost {
  readonly connection: DaemonConnection;
  readonly createClient?: CatalogClientFactory;
  /** A seam for tests and the harness: which row features to offer. Every feature by default (no negotiation). */
  readonly features?: CatalogFeatures;
}

export interface CatalogRowsRead {
  readonly installs: readonly CatalogInstall[];
  readonly catalogs: readonly OwnedCatalog[];
  /** The catalog one tap adds to, when the machine has made one. */
  readonly defaultCatalogId?: string;
  readonly features: CatalogFeatures;
  readonly reload: () => void;
}

/** What one store says, as the row reads it: the lists, the features on offer and the reload a Publish or Uninstall asks for. */
export function useCatalogRowsStore(
  store: CatalogRowsStore,
  features: CatalogFeatures = ALL_CATALOG_FEATURES,
): CatalogRowsRead {
  const snapshot = useSyncExternalStore(store.subscribe, store.get);
  return { ...snapshot, features, reload: store.reload };
}

/** The installs and catalogs of this machine, read again on `reload`. Each is empty until read, and when it cannot be read. */
export function useCatalogRows(host: CatalogRowsHost | undefined): CatalogRowsRead {
  const routed = useDaemonClient();
  const connection = host?.connection;
  const createClient = host?.createClient ?? routed;
  const store = useMemo(
    () =>
      createCatalogRowsStore(async () =>
        connection === undefined
          ? { installs: [], catalogs: [] }
          : await readCatalogRows(async () => await createClient(connection)),
      ),
    [connection, createClient],
  );
  return useCatalogRowsStore(store, host?.features);
}

/**
 * The paste field and the file install, as one block: the top of Sharing › Subscriptions.
 */
export function AddCatalogEntry({ host }: { readonly host: CatalogRowsHost }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-xs" data-catalog-add-entry="">
      <AddCatalogFromLink />
      <div>
        <CatalogMoreMenu onInstallFromFile={() => setOpen(true)} />
      </div>
      {open ? (
        <InstallFromFileSheet
          connection={host.connection}
          onClose={() => setOpen(false)}
          {...(host.createClient === undefined ? {} : { host: { createClient: host.createClient } })}
        />
      ) : null}
    </div>
  );
}
