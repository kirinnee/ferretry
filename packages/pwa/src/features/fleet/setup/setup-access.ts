/**
 * The setup surface's GUARDED reads and acts (docs/design/account-model.md §7, §9.6).
 *
 * The setup scan, the Clone export and the migration's dry run are `fleet.configure` reads — the scan
 * names every secret key and the export is everything a clone copies. Installing a tool and migrating
 * are guarded acts that are not staged changes. A caller off the machine is asked for its passkey by the
 * carrier when the daemon wants one, so this module only runs the work and words a refusal.
 */

import { useCallback } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import type { FleetClient, FleetClientFactory } from '../fleet-client.ts';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { type AccountChanges, useAccountChanges } from '../shell/apply-change-panel.tsx';

export type Guarded<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'refused'; readonly sentence: string };

export interface SetupAccess {
  /** The shared change state: authority, busy, the last refusal, and staged changes. */
  readonly changes: AccountChanges;
  /** One guarded read. */
  readonly read: <T>(work: (client: FleetClient) => Promise<T>) => Promise<Guarded<T>>;
  /** One guarded act that is not a staged change: an install, a migration. A refusal is also shown on `changes`. */
  readonly act: <T>(work: (client: FleetClient) => Promise<T>) => Promise<Guarded<T>>;
}

export interface UseSetupAccessOptions {
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
}

export function useSetupAccess({ connection, createClient }: UseSetupAccessOptions): SetupAccess {
  const changes = useAccountChanges({ connection, createClient });

  const read = useCallback(
    async <T>(work: (client: FleetClient) => Promise<T>): Promise<Guarded<T>> => {
      try {
        return { kind: 'done', value: await work(await createClient(connection)) };
      } catch (error) {
        return { kind: 'refused', sentence: changeRefusalSentence(error) };
      }
    },
    [connection, createClient],
  );

  const act = useCallback(
    async <T>(work: (client: FleetClient) => Promise<T>): Promise<Guarded<T>> => {
      const result = await read(work);
      if (result.kind === 'refused') changes.refuse(result.sentence);
      return result;
    },
    [changes, read],
  );

  return { changes, read, act };
}
