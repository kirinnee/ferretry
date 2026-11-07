import type { SessionView } from '../../contract/index.ts';
import { useCallback, useSyncExternalStore } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { AppStore } from '@ferretry/app';
import { TERMINAL_STATUSES } from '@ferretry/app';

/**
 * IS THIS COMPUTER RUNNING A FERRETRY TOO OLD TO AUTO-READ? Pure.
 *
 * Auto-read needs the daemon to say whose turn it is (`state.turnState`) — a newer Ferretry does that for every
 * live ferret. An older one says nothing. So a machine is OLDER only when it has at least one live ferret and NONE
 * of its live ferrets carries a turn: a machine with no ferrets, or only finished ones, proves nothing and gets
 * no note.
 */
export const machineIsOlder = (sessions: readonly SessionView[] | null): boolean => {
  const live = (sessions ?? []).filter(session => !TERMINAL_STATUSES.has(session.state.status));
  return live.length > 0 && live.every(session => session.state.turnState === undefined);
};

/** The same, for the machine whose settings are open, kept live from the fleet; false without a machine or a store. */
export function useMachineIsOlder(store: AppStore | null, daemon: DaemonConnection | undefined): boolean {
  const subscribe = useCallback(
    (listener: () => void) => (store === null ? () => undefined : store.fleet.subscribe(listener)),
    [store],
  );
  const older = useCallback(
    () =>
      store === null || daemon === undefined ? false : machineIsOlder(store.fleet.fleet(daemon.daemonId).sessions),
    [store, daemon],
  );
  return useSyncExternalStore(subscribe, older, () => false);
}
