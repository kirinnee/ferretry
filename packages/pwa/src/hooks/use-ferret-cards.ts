/**
 * THIS FERRET'S CARDS: the one board read the chat's task search, its `&` menu and its `&F12` proof share.
 *
 * `ferret = <session>`, `state = all`, on this machine, through the U10 store, so it is the same read (and
 * the same cache) the card chip makes. A host with no board store has no cards to search and says so as an
 * empty, ready slice, never as an error.
 */

import { useMemo } from 'react';
import type { BoardPort } from '../lib/board-client.ts';
import { NO_BOARD_FILTERS } from '../lib/board-model.ts';
import { DaemonBoardStore } from '../lib/board-store.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { type SessionCard, sessionCards } from '../lib/session-cards.ts';
import { type BoardMachine, useBoard } from './use-board.ts';

const refuse = (): Promise<never> => Promise.reject(new Error('this host has no board'));
const IDLE_STORE = new DaemonBoardStore({
  board: refuse,
  task: refuse,
  projects: refuse,
  lanes: refuse,
  create: refuse,
  version: refuse,
  act: refuse,
} satisfies BoardPort);
const NO_MACHINES: readonly BoardMachine[] = [];
const NO_CARDS: readonly SessionCard[] = [];

type FerretCardsState = 'loading' | 'ready' | 'unavailable';

export interface FerretCards {
  readonly state: FerretCardsState;
  readonly error: string | null;
  readonly cards: readonly SessionCard[];
}

/** `store` absent: the host has no board. `sessionId` absent: no session is open, so nothing is read. */
export const useFerretCards = (
  store: DaemonBoardStore | undefined,
  connection: DaemonConnection,
  sessionId: string | null,
): FerretCards => {
  const reading = store !== undefined && sessionId !== null;
  const machines = useMemo<readonly BoardMachine[]>(
    () => (reading ? [{ connection, name: connection.daemonName ?? connection.daemonId }] : NO_MACHINES),
    [reading, connection],
  );
  const filters = useMemo(() => ({ ...NO_BOARD_FILTERS, ferret: sessionId, state: 'all' as const }), [sessionId]);
  const board = useBoard(store ?? IDLE_STORE, machines, filters, { beat: false });
  const { model, status, machines: statuses } = board;
  const daemonId = connection.daemonId;
  const cards = useMemo(
    () => (sessionId === null || store === undefined ? NO_CARDS : sessionCards(model, daemonId, sessionId)),
    [model, daemonId, sessionId, store],
  );
  return useMemo<FerretCards>(() => {
    if (sessionId === null) return { state: 'loading', error: null, cards };
    if (store === undefined) return { state: 'ready', error: null, cards };
    if (status === 'ready') return { state: 'ready', error: null, cards };
    if (status === 'error') {
      return { state: 'unavailable', error: statuses[0]?.error ?? 'the board could not be read', cards };
    }
    return { state: 'loading', error: null, cards };
  }, [status, statuses, cards, store, sessionId]);
};
