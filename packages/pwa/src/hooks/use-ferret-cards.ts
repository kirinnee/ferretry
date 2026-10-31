/**
 * THIS FERRET'S CARDS: the one board read the chat's task search, its `&` menu and its `&F12` proof share.
 *
 * `ferret = <session>`, `state = all`, on this machine, through the U10 store, so it is the same read (and
 * the same cache) the card chip makes. A host with no board store has no cards to search and says so as an
 * empty, ready slice, never as an error.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { BoardPort } from '../lib/board-client.ts';
import { NO_BOARD_FILTERS } from '../lib/board-model.ts';
import { DaemonBoardStore } from '../lib/board-store.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { projectCards, type SessionCard, sessionCards } from '../lib/session-cards.ts';
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

export interface ProjectCards extends FerretCards {
  /** The project read already in flight, or nothing once it settles: a menu awaits it rather than offer an empty list. */
  readonly wait: () => Promise<void> | undefined;
}

/**
 * EVERY CARD OF THE FERRET'S PROJECT, owned or not: what the `&` menu and the `&F12` proof read, so a card the
 * owner asked for stays offered whoever holds it. `projectId` absent: nothing is read, and the state stays `loading`.
 */
export const useProjectCards = (
  store: DaemonBoardStore | undefined,
  connection: DaemonConnection,
  sessionId: string | null,
  projectId: string | null,
): ProjectCards => {
  const reading = store !== undefined && sessionId !== null && projectId !== null;
  const machines = useMemo<readonly BoardMachine[]>(
    () => (reading ? [{ connection, name: connection.daemonName ?? connection.daemonId }] : NO_MACHINES),
    [reading, connection],
  );
  const filters = useMemo(
    () => ({ ...NO_BOARD_FILTERS, project: projectId, agents: true, state: 'all' as const }),
    [projectId],
  );
  const board = useBoard(store ?? IDLE_STORE, machines, filters, { beat: false });
  const { model, status, machines: statuses } = board;
  const daemonId = connection.daemonId;
  const cards = useMemo(
    () => (reading ? projectCards(model, daemonId, sessionId) : NO_CARDS),
    [reading, model, daemonId, sessionId],
  );
  const state: FerretCardsState = !reading
    ? 'loading'
    : status === 'ready'
      ? 'ready'
      : status === 'error'
        ? 'unavailable'
        : 'loading';
  const error = state === 'unavailable' ? (statuses[0]?.error ?? 'the board could not be read') : null;

  const pending = useRef<{ readonly promise: Promise<void>; readonly settle: () => void } | null>(null);
  useEffect(() => {
    if (state !== 'loading' || !reading) {
      pending.current?.settle();
      pending.current = null;
      return;
    }
    if (pending.current !== null) return;
    let settle: () => void = () => undefined;
    const promise = new Promise<void>(resolve => {
      settle = resolve;
    });
    pending.current = { promise, settle };
  }, [state, reading]);
  useEffect(
    () => () => {
      pending.current?.settle();
      pending.current = null;
    },
    [],
  );
  const wait = useCallback((): Promise<void> | undefined => pending.current?.promise, []);
  return useMemo<ProjectCards>(() => ({ state, error, cards, wait }), [state, error, cards, wait]);
};
