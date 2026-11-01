/**
 * What a Skills or MCP row adds for catalogs: "Add to catalog…", and, for something a catalog install
 * wrote, "From ‹catalog› (‹publisher›)" with a Remove that asks first.
 *
 * Rows carry no provenance of their own, so the installs this machine recorded are read once for the
 * list and matched to each row by kind and name. A read that fails shows nothing: the row is still right.
 */

import type { CatalogInstall, CatalogItemSource } from '@ferretry/protocol';
import { PackagePlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import { Button } from '../../shell/primitives.tsx';
import { AddToCatalogSheet } from './add-to-catalog-sheet.tsx';
import { listCatalogInstalls, removeCatalogInstall } from './catalog-installs-api.ts';
import { installedFromLine, installRefusal, installsFor, REMOVE_NOTE } from './catalog-install-model.ts';
import { FailureLine } from './catalog-parts.tsx';
import { AddCatalogFromLink } from './add-from-link.tsx';
import { CatalogMoreMenu } from './catalog-more-menu.tsx';
import { InstallFromFileSheet } from './install-from-file-sheet.tsx';
import type { CatalogClientFactory } from './catalogs-api.ts';

/** Which machine the rows belong to. `createClient` is a test and harness seam. */
export interface CatalogRowsHost {
  readonly connection: DaemonConnection;
  readonly createClient?: CatalogClientFactory;
}

export interface CatalogInstallsRead {
  readonly installs: readonly CatalogInstall[];
  readonly reload: () => void;
}

const NO_INSTALLS: readonly CatalogInstall[] = [];

/** The installs this machine recorded, read again on `reload`. Empty until read, and when it cannot be read. */
export function useCatalogInstalls(host: CatalogRowsHost | undefined): CatalogInstallsRead {
  const routed = useDaemonClient();
  const [installs, setInstalls] = useState<readonly CatalogInstall[]>(NO_INSTALLS);
  const [tick, setTick] = useState(0);
  const connection = host?.connection;
  const createClient = host?.createClient ?? routed;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the reload request; the read does not use it.
  useEffect(() => {
    if (connection === undefined) return;
    let live = true;
    void createClient(connection)
      .then(async client => await listCatalogInstalls(client))
      .then(list => {
        if (live) setInstalls(list.installs);
      })
      .catch(() => {
        if (live) setInstalls(NO_INSTALLS);
      });
    return () => {
      live = false;
    };
  }, [connection, createClient, tick]);

  const reload = useCallback(() => setTick(value => value + 1), []);
  return { installs, reload };
}

export interface CatalogRowToolsProps {
  readonly host: CatalogRowsHost;
  readonly kind: 'skill' | 'mcp';
  /** The skill or server name, as the row says it. */
  readonly name: string;
  /** What "Add to catalog…" points at: the exact SKILL.md path or the exact server id. */
  readonly source: CatalogItemSource;
  readonly read: CatalogInstallsRead;
}

export function CatalogRowTools({ host, kind, name, source, read }: CatalogRowToolsProps) {
  const routed = useDaemonClient();
  const createClient = host.createClient ?? routed;
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const matches = installsFor(read.installs, kind, name);

  const remove = async (install: CatalogInstall): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await removeCatalogInstall(await createClient(host.connection), install.target.scope, install.installId);
      setRemoving(null);
      read.reload();
    } catch (error) {
      setFailure(installRefusal(error).sentence);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-xs" data-catalog-row-tools={name}>
      {matches.map(install => (
        <div key={install.installId} className="flex min-w-0 flex-col gap-xs" data-catalog-installed-from="">
          <div className="flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs">
            <span className="min-w-0 flex-1 break-words text-meta text-muted">{installedFromLine(install)}</span>
            {removing === install.installId ? null : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label={`Remove ${name}, installed from ${install.provenance.catalogName}`}
                onClick={() => {
                  setFailure(null);
                  setRemoving(install.installId);
                }}
                data-catalog-remove=""
              >
                Remove
              </Button>
            )}
          </div>
          {removing === install.installId ? (
            <div
              className="flex min-w-0 flex-col gap-xs rounded-control border border-warn-border bg-warn-bg p-control-x py-2 text-warn"
              data-catalog-remove-confirm=""
            >
              <p className="m-0 break-words text-cell font-semibold">
                Remove {name} from {install.destination}?
              </p>
              <p className="m-0 text-cell">{REMOVE_NOTE}</p>
              <div className="flex flex-wrap gap-xs">
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => void remove(install)}
                  data-catalog-remove-yes=""
                >
                  {busy ? 'Removing…' : 'Remove it'}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setRemoving(null)}
                  data-catalog-remove-no=""
                >
                  Keep it
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
      {failure === null ? null : <FailureLine sentence={failure} />}
      <div>
        <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(true)} data-catalog-add-to={name}>
          <PackagePlus size={14} aria-hidden="true" />
          Add to catalog…
        </Button>
      </div>
      {adding ? (
        <AddToCatalogSheet
          connection={host.connection}
          source={source}
          label={name}
          onClose={() => setAdding(false)}
          {...(host.createClient === undefined ? {} : { createClient: host.createClient })}
        />
      ) : null}
    </div>
  );
}

/**
 * The way to add a catalog on a list that has nothing to open it from: a link first, and the file under More.
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
