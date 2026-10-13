/**
 * The three catalogue reads the Profiles and Components tabs share: components, profile stacks and
 * runtimes (docs/design/account-model.md §7), made through the app's client pool.
 *
 * One read of all three, because every page on these tabs needs at least two of them — a component's
 * "Used by" names profiles, a profile's "Where it is used" names runtimes — and a pair of reads that
 * disagreed would count the same thing twice differently. After any change the whole catalogue is read
 * again; nothing is patched in place, so what the page shows is always what the daemon answered.
 */

import type {
  FleetComponentCatalog,
  FleetComponentView,
  FleetLayeredProfileCatalog,
  FleetRuntimeCatalog,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { readFleetComponents, readFleetProfiles, readFleetRuntimes } from '../catalog-api.ts';
import type { FleetClient, FleetClientFactory } from '../fleet-client.ts';

export interface AccountCatalog {
  readonly components: FleetComponentCatalog;
  readonly profiles: FleetLayeredProfileCatalog;
  readonly runtimes: FleetRuntimeCatalog;
}

export type AccountCatalogRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly catalog: AccountCatalog }
  /** It answered with a refusal, or did not answer: the sentence says which. */
  | { readonly kind: 'failed'; readonly reason: string };

/** One read of all three; never throws. */
export async function readAccountCatalog(client: () => Promise<FleetClient>): Promise<AccountCatalogRead> {
  try {
    const fleet = await client();
    const [components, profiles, runtimes] = await Promise.all([
      readFleetComponents(fleet),
      readFleetProfiles(fleet),
      readFleetRuntimes(fleet),
    ]);
    return { kind: 'ready', catalog: { components, profiles, runtimes } };
  } catch (error) {
    return {
      kind: 'failed',
      reason:
        error instanceof FyHttpError
          ? `This machine answered but did not share its setup: ${error.message}`
          : 'This machine did not answer, so its setup cannot be shown right now.',
    };
  }
}

/** Every component, across the six kinds. */
export const allComponents = (catalog: AccountCatalog): readonly FleetComponentView[] =>
  catalog.components.kinds.flatMap(group => group.components);

export interface UseAccountCatalog {
  readonly read: AccountCatalogRead;
  /** Read again; answers the new read so a caller can pick what it just made. */
  readonly reload: () => Promise<AccountCatalogRead>;
}

/** The catalogue for one machine, read on mount and on demand. A newer read always wins. */
export function useAccountCatalog(connection: DaemonConnection, createClient: FleetClientFactory): UseAccountCatalog {
  const [read, setRead] = useState<AccountCatalogRead>({ kind: 'loading' });
  const generation = useRef(0);
  const reload = useCallback(async (): Promise<AccountCatalogRead> => {
    generation.current += 1;
    const mine = generation.current;
    const next = await readAccountCatalog(() => createClient(connection));
    if (mine === generation.current) setRead(next);
    return next;
  }, [connection, createClient]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { read, reload };
}
