/** A card's Agenda asks: the agendas of the ferrets that can hold them, read when the card changes. */

import { useEffect, useMemo, useState } from 'react';
import type { CardView } from '../../contract/index.ts';
import { type CardAsks, askSessions, collectAsks, type SessionAgenda } from '../lib/board-asks.ts';
import type { DaemonBoardStore } from '../lib/board-store.ts';
import type { DaemonConnection } from '../lib/machine.ts';

export const useCardAsks = (store: DaemonBoardStore, machine: DaemonConnection, card: CardView): CardAsks => {
  const key = askSessions(card).join('|');
  // The card's own value changes when the board moves it or an ask opens or closes: read the agendas again then.
  const [read, setRead] = useState<{ readonly for: string; readonly agendas: readonly SessionAgenda[] } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the list of sessions; `card` says when to re-read
  useEffect(() => {
    let live = true;
    void Promise.all(
      askSessions(card).map(async sessionId => ({
        sessionId,
        snapshot: await store.agendaOf(machine, sessionId).catch(() => null),
      })),
    ).then(agendas => {
      if (live) setRead({ for: key, agendas });
    });
    return () => {
      live = false;
    };
  }, [store, machine, key, card]);
  return useMemo(
    () =>
      collectAsks(
        card,
        read !== null && read.for === key
          ? read.agendas
          : askSessions(card).map(sessionId => ({ sessionId, snapshot: null })),
      ),
    [card, read, key],
  );
};
