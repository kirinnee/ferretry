/**
 * Which items of a publisher this browser's paired machines already installed, read from the install
 * records the machines keep (their provenance is what the machine VERIFIED). A publisher's signed list names
 * a withdrawn item by id only, so an installed one is matched by id and named from its own record.
 */

import type { CatalogInstall } from '@ferretry/protocol';
import { useEffect, useState } from 'react';
import { listCatalogInstalls } from '../catalogs/catalog-installs-api.ts';
import type { InstallHost } from '../catalogs/install-from-file-sheet.tsx';
import { useDaemonClient } from '../../lib/store.tsx';
import type { InstallMachine } from './shared-item-sheet.tsx';

/** Item id → the name the machine recorded, for one publisher's installs. */
export function installedNames(installs: readonly CatalogInstall[], publisher: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const install of installs) {
    if (install.provenance.publisher === publisher) names.set(install.provenance.itemId, install.provenance.name);
  }
  return names;
}

/** What the paired machines installed from `publisher`. Empty until read, and where nothing can be read. */
export function useInstalledFromPublisher(
  publisher: string,
  machines: readonly InstallMachine[],
  host: InstallHost | undefined,
): ReadonlyMap<string, string> {
  const routed = useDaemonClient();
  const createClient = host?.createClient ?? routed;
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    if (machines.length === 0) {
      setNames(new Map());
      return;
    }
    let live = true;
    void Promise.all(
      machines.map(async machine => {
        try {
          const { installs } = await listCatalogInstalls(await createClient(machine.connection));
          return Array.isArray(installs) ? installs : [];
        } catch {
          return [];
        }
      }),
    ).then(lists => {
      if (live) setNames(installedNames(lists.flat(), publisher));
    });
    return () => {
      live = false;
    };
  }, [machines, createClient, publisher]);
  return names;
}
