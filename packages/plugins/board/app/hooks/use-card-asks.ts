/**
 * A card's Agenda asks, LIVE (v4's `useBoardAsks`): the agendas of the ferrets that can hold them are watched in the
 * board store for as long as the card is open, and re-read when the machine says that ferret's asks changed
 * (`asks.changed`, noted by the runtime). The rows follow every later snapshot with no board refresh and no remount;
 * the watch is released on unmount.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { CardView } from '../../contract/index.ts';
import { askSessions, type CardAsks, collectAsks } from '../lib/board-asks.ts';
import type { DaemonBoardStore } from '../lib/board-store.ts';
import type { DaemonConnection } from '../lib/machine.ts';

export const useCardAsks = (store: DaemonBoardStore, machine: DaemonConnection, card: CardView): CardAsks => {
  const sessions = askSessions(card);
  const key = sessions.join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the list of sessions
  const held = useMemo(() => sessions, [key]);
  useEffect(() => {
    const releases = held.map(ferret => store.watchAgenda(machine, ferret));
    return () => {
      for (const release of releases) release();
    };
  }, [store, machine, held]);
  const stamp = useSyncExternalStore(
    store.subscribe,
    () => store.agendaStamp(machine.daemonId, held),
    () => store.agendaStamp(machine.daemonId, held),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stamp` is what moves when an agenda does
  return useMemo(
    () =>
      collectAsks(
        card,
        held.map(sessionId => ({ sessionId, snapshot: store.agendaSnapshot(machine.daemonId, sessionId) })),
      ),
    [card, held, stamp, store, machine.daemonId],
  );
};
