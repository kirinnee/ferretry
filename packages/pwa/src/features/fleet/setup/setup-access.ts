/**
 * Getting this browser past a machine's gate for the setup surface's GUARDED reads and acts
 * (docs/design/account-model.md §7, §9.6).
 *
 * The setup scan, the Clone export and the migration's dry run are `fleet.configure` reads — the scan
 * names every secret key and the export is everything a clone copies — so a browser that is locked
 * out of this machine must unlock before it can even look. Installing a tool and migrating are guarded
 * acts that are not staged changes. Both go through the ONE shared gate, `useAccountChanges().authorize`
 * (`shell/apply-change-panel.tsx`), which mints the unlock and hands back the confirmation an act owes;
 * this module only keeps the unlock it minted so the next read on this machine can send it.
 *
 * The password is a parameter for one call and is never kept. The unlock token is kept, stamped with
 * the daemon that minted it, exactly as the change helper keeps its own.
 */

import { useCallback, useRef, useState } from 'react';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { type HeldUnlock, usableUnlock } from '../../../lib/grants.ts';
import type { FleetClient } from '../fleet-api.ts';
import type { FleetClientFactory } from '../fleet-configuration-surface.tsx';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import { type AccountChanges, useAccountChanges } from '../shell/apply-change-panel.tsx';

export type Guarded<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'refused'; readonly sentence: string; readonly passwordRejected: boolean };

/** What a guarded act sends with its own request. */
export interface ActAuthorization {
  readonly unlock?: string;
  readonly operatorPassword?: string;
}

export interface SetupAccess {
  /** The shared change state: authority, busy, the last refusal, and staged changes. */
  readonly changes: AccountChanges;
  /** Locked out with no unlock in hand: a guarded read needs the operator password first. */
  readonly locked: boolean;
  /** One guarded read. `password` is only spent when the browser is locked out. */
  readonly read: <T>(
    work: (client: FleetClient, unlock: string | undefined) => Promise<T>,
    password?: string,
  ) => Promise<Guarded<T>>;
  /** One guarded act that is not a staged change: an install, a migration. */
  readonly act: <T>(
    work: (client: FleetClient, authorization: ActAuthorization) => Promise<T>,
    password?: string,
  ) => Promise<Guarded<T>>;
}

export interface UseSetupAccessOptions {
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  /** Supplied in tests. */
  readonly now?: () => number;
}

export function useSetupAccess({ connection, createClient, now = Date.now }: UseSetupAccessOptions): SetupAccess {
  const changes = useAccountChanges({ connection, createClient, now });
  // A ref for the calls (a second read right after an unlock must already see it) and state for the render.
  const held = useRef<HeldUnlock | null>(null);
  const [, setHeldVersion] = useState(0);
  const remember = useCallback((next: HeldUnlock | null): void => {
    held.current = next;
    setHeldVersion(version => version + 1);
  }, []);
  const tokenNow = useCallback(
    (): string | undefined => usableUnlock(held.current, connection.daemonId, now()),
    [connection.daemonId, now],
  );
  const locked = changes.authority?.kind === 'locked' && tokenNow() === undefined;

  const run = useCallback(
    async <T>(work: (client: FleetClient) => Promise<T>): Promise<Guarded<T>> => {
      try {
        return { kind: 'done', value: await work(await createClient(connection)) };
      } catch (error) {
        return { kind: 'refused', sentence: changeRefusalSentence(error), passwordRejected: false };
      }
    },
    [connection, createClient],
  );

  const read = useCallback(
    async <T>(
      work: (client: FleetClient, unlock: string | undefined) => Promise<T>,
      password?: string,
    ): Promise<Guarded<T>> => {
      let unlock = tokenNow();
      if (unlock === undefined && changes.authority?.kind === 'locked') {
        const authorized = await changes.authorize(password);
        if (authorized.kind === 'refused') return authorized;
        remember(authorized.held);
        unlock = authorized.unlock;
      }
      return await run(client => work(client, unlock));
    },
    [changes, remember, run, tokenNow],
  );

  const act = useCallback(
    async <T>(
      work: (client: FleetClient, authorization: ActAuthorization) => Promise<T>,
      password?: string,
    ): Promise<Guarded<T>> => {
      const authorized = await changes.authorize(password);
      if (authorized.kind === 'refused') return authorized;
      remember(authorized.held);
      const authorization: ActAuthorization = {
        ...(authorized.unlock === undefined ? {} : { unlock: authorized.unlock }),
        ...(authorized.operatorPassword === undefined ? {} : { operatorPassword: authorized.operatorPassword }),
      };
      const result = await run(client => work(client, authorization));
      if (result.kind === 'refused') changes.refuse(result.sentence);
      return result;
    },
    [changes, remember, run],
  );

  return { changes, locked, read, act };
}
