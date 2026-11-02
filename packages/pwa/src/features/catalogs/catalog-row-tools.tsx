/**
 * What the Skills and MCP lists read once so every row can say where its item stands in catalogs: the
 * installs this machine recorded (matched to a row by kind and name) and this machine's own catalogs
 * (matched by source). A read that fails shows nothing: the row is still right. The row itself is
 * `catalog-item-row.tsx`.
 */

import type { CatalogInstall, OwnedCatalog } from '@ferretry/protocol';
import { useCallback, useEffect, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonSharingPath } from '../../lib/pages/routes.ts';
import { useOptionalRouter } from '../../lib/router.tsx';
import { useDaemonClient } from '../../lib/store.tsx';
import { AddCatalogFromLink } from './add-from-link.tsx';
import { listCatalogInstalls } from './catalog-installs-api.ts';
import { CatalogMoreMenu } from './catalog-more-menu.tsx';
import {
  type CatalogClientFactory,
  type CatalogFeatures,
  listCatalogs,
  NO_CATALOG_FEATURES,
  readCatalogFeatures,
} from './catalogs-api.ts';
import { InstallFromFileSheet } from './install-from-file-sheet.tsx';

/** Which machine the rows belong to. `createClient` is a test and harness seam. */
export interface CatalogRowsHost {
  readonly connection: DaemonConnection;
  readonly createClient?: CatalogClientFactory;
}

export interface CatalogRowsRead {
  readonly installs: readonly CatalogInstall[];
  readonly catalogs: readonly OwnedCatalog[];
  /** The catalog one tap adds to, when the machine has made one. */
  readonly defaultCatalogId?: string;
  readonly features: CatalogFeatures;
  readonly reload: () => void;
}

const NO_INSTALLS: readonly CatalogInstall[] = [];
const NO_CATALOGS: readonly OwnedCatalog[] = [];

/** The installs and catalogs of this machine, read again on `reload`. Each is empty until read, and when it cannot be read. */
export function useCatalogRows(host: CatalogRowsHost | undefined): CatalogRowsRead {
  const routed = useDaemonClient();
  const [installs, setInstalls] = useState<readonly CatalogInstall[]>(NO_INSTALLS);
  const [catalogs, setCatalogs] = useState<readonly OwnedCatalog[]>(NO_CATALOGS);
  const [defaultCatalogId, setDefaultCatalogId] = useState<string | undefined>(undefined);
  const [features, setFeatures] = useState<CatalogFeatures>(NO_CATALOG_FEATURES);
  const [tick, setTick] = useState(0);
  const connection = host?.connection;
  const createClient = host?.createClient ?? routed;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the reload request; the read does not use it.
  useEffect(() => {
    if (connection === undefined) return;
    let live = true;
    const client = createClient(connection);
    void client
      .then(async api => await listCatalogInstalls(api))
      .then(list => {
        if (live) setInstalls(list.installs);
      })
      .catch(() => {
        if (live) setInstalls(NO_INSTALLS);
      });
    void client
      .then(async api => await listCatalogs(api))
      .then(list => {
        if (live) {
          setCatalogs(list.catalogs);
          setDefaultCatalogId(list.defaultCatalogId);
        }
      })
      .catch(() => {
        if (live) {
          setCatalogs(NO_CATALOGS);
          setDefaultCatalogId(undefined);
        }
      });
    void client
      .then(async api => await readCatalogFeatures(api))
      .then(read => {
        if (live) setFeatures(read);
      })
      .catch(() => {
        if (live) setFeatures(NO_CATALOG_FEATURES);
      });
    return () => {
      live = false;
    };
  }, [connection, createClient, tick]);

  const reload = useCallback(() => setTick(value => value + 1), []);
  return { installs, catalogs, features, reload, ...(defaultCatalogId === undefined ? {} : { defaultCatalogId }) };
}

/**
 * The side panel's one quiet way to add a catalog: a text link that opens Sharing › Shared with me, where the
 * paste field and Install from a file live (`AddCatalogEntry`).
 */
export function AddFromLinkLink({ host }: { readonly host: CatalogRowsHost }) {
  const router = useOptionalRouter();
  const to = daemonSharingPath(host.connection.daemonId, 'shared');
  return (
    <button
      className="fy-info-link"
      data-catalog-add-link=""
      onClick={() => (router === null ? window.location.assign(to) : router.navigate(to))}
      type="button"
    >
      Add from a link…
    </button>
  );
}

/**
 * The paste field and the file install, as one block: the top of Sharing › Shared with me.
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
