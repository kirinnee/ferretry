/**
 * Which items of a publisher this browser's paired machines already installed, read from the install
 * records the machines keep (their provenance is what the machine VERIFIED). A publisher's signed list names
 * a withdrawn item by id only, so an installed one is matched by id and named from its own record.
 */

import type { CatalogInstall } from '../../../contract/wire/index.ts';
import { useCallback, useEffect, useState } from 'react';
import { listCatalogInstalls } from '../catalogs/catalog-installs-api.ts';
import type { InstallHost } from '../catalogs/install-from-file-sheet.tsx';
import { useDaemonClient } from '../../lib/client-context.tsx';
import type { InstallMachine } from './shared-item-sheet.tsx';

/** Item id → the name the machine recorded, for one publisher's installs. */
export function installedNames(installs: readonly CatalogInstall[], publisher: string): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const install of installs) {
    if (install.provenance.publisher === publisher) names.set(install.provenance.itemId, install.provenance.name);
  }
  return names;
}

/** One install of an item on one paired machine, as that machine recorded it. */
export interface InstalledItem {
  readonly name: string;
  readonly version: number;
  readonly install: CatalogInstall;
  readonly machine: InstallMachine;
}

/**
 * Item id → the install the store row speaks for. An item installed in several places shows the oldest copy, since
 * that is the one an update helps most; a tie keeps the first machine listed.
 */
export function installedItems(
  lists: readonly { readonly machine: InstallMachine; readonly installs: readonly CatalogInstall[] }[],
  publisher: string,
): ReadonlyMap<string, InstalledItem> {
  const items = new Map<string, InstalledItem>();
  for (const { machine, installs } of lists) {
    for (const install of installs) {
      const { provenance } = install;
      if (provenance.publisher !== publisher) continue;
      const held = items.get(provenance.itemId);
      if (held === undefined || provenance.version < held.version)
        items.set(provenance.itemId, { name: provenance.name, version: provenance.version, install, machine });
    }
  }
  return items;
}

/** Item id → name, for the sentences that name an item only by its record. */
export function itemNames(items: ReadonlyMap<string, InstalledItem>): ReadonlyMap<string, string> {
  return new Map([...items].map(([itemId, item]) => [itemId, item.name]));
}

export interface InstalledFromPublisher {
  readonly items: ReadonlyMap<string, InstalledItem>;
  /** Reads the machines' records again, after a change. */
  readonly refresh: () => void;
}

/** What the paired machines installed from `publisher`. Empty until read, and where nothing can be read. */
export function useInstalledFromPublisher(
  publisher: string,
  machines: readonly InstallMachine[],
  host: InstallHost | undefined,
): InstalledFromPublisher {
  const routed = useDaemonClient();
  const createClient = host?.createClient ?? routed;
  const [items, setItems] = useState<ReadonlyMap<string, InstalledItem>>(() => new Map());
  const [reads, setReads] = useState(0);
  const refresh = useCallback(() => setReads(count => count + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` is the trigger; a change of the records asks for a new read
  useEffect(() => {
    if (machines.length === 0) {
      setItems(new Map());
      return;
    }
    let live = true;
    void Promise.all(
      machines.map(async machine => {
        try {
          const { installs } = await listCatalogInstalls(await createClient(machine.connection));
          return { machine, installs: Array.isArray(installs) ? installs : [] };
        } catch {
          return { machine, installs: [] };
        }
      }),
    ).then(lists => {
      if (live) setItems(installedItems(lists, publisher));
    });
    return () => {
      live = false;
    };
  }, [machines, createClient, publisher, reads]);
  return { items, refresh };
}
