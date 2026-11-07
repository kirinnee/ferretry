/**
 * EVERY CARD ID ON ONE MACHINE: what a `&F12` reference is proved against, whatever project the card is on.
 *
 * One read per machine through the board store, shared by every surface that draws a reference, and kept
 * current by the `board.changed` feed. `undefined` is "not known": the list has not been read yet, or the
 * machine is an older daemon that does not serve it. Neither is "no cards", so neither proves anything.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { DaemonBoardStore } from '../lib/board-store.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { pairingKey } from './use-machines-poll.ts';

export const useMachineTaskIds = (
  store: DaemonBoardStore | undefined,
  connection: DaemonConnection | undefined,
): ReadonlySet<string> | undefined => {
  const key = connection === undefined ? '' : pairingKey([connection]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairing's facts are the deliberate key
  useEffect(() => {
    if (store !== undefined && connection !== undefined) store.watchIds(connection);
  }, [store, key]);
  return (
    useSyncExternalStore(
      listener => store?.subscribe(listener) ?? (() => undefined),
      () => (store === undefined || connection === undefined ? undefined : store.idsState(connection.daemonId).ids),
    ) ?? undefined
  );
};
