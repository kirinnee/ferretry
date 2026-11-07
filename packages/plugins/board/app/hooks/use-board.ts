/**
 * THE BOARD, as hooks the pages build on. No markup here: a page takes a model and draws it.
 *
 *   useBoard(store, machines, filters)   every paired machine's cards, grouped project → lane, with the
 *                                        header's counts; live (`board.changed`) and re-derived every 30s
 *   useBoardCard(store, machine, id)     one card in full, by `(machine, id)`
 *   useBoardTasks(store, machine, ids)   several cards in full, in the order asked for
 *   useBoardProjects(store, machines)    each machine's projects with their lane sets
 *   useBoardActions(store, ms)           move / reopen / depend / note / link / drop / editField
 *   useBoardFilters(...)                 the filter set read from, and written to, the URL query
 *
 * They take the store and the machines as arguments, like `useProjects`: the page that mounts them says
 * where they read. The filters are the URL's (`project, machine, ferret, kind, pr, state, activity, mine, lane, created, touched`),
 * so a link to a filtered board is the board.
 */

import type { CardId } from '../../contract/index.ts';
import { useNow } from '@ferretry/app/ui';
import { useCallback, useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react';
import { type BoardActions, createBoardActions } from '../lib/board-actions.ts';
import {
  type BoardFilters,
  type BoardMachineData,
  type BoardModel,
  boardFiltersToSearch,
  mergeBoard,
  parseBoardFilters,
  toServerQuery,
} from '../lib/board-model.ts';
import { boardPrivate } from '../lib/board-private-preference.ts';
import {
  type BoardLoadStatus,
  type BoardMachineSlice,
  type BoardProjectsState,
  type BoardCardState,
  boardViewKey,
  type DaemonBoardStore,
  IDLE_BOARD_TASK,
} from '../lib/board-store.ts';
import { type DaemonConnection, type DaemonId, pairingKey } from '../lib/machine.ts';

/** A paired machine and the name the page shows for it. */
export interface BoardMachine {
  readonly connection: DaemonConnection;
  readonly name: string;
}

/** One machine's part of the read, as a page reports it. */
interface BoardMachineStatus {
  readonly daemonId: DaemonId;
  readonly machine: string;
  readonly status: BoardLoadStatus;
  readonly error: string | null;
  /** The machine has more cards than were read; its counts still cover all of it. */
  readonly truncated: boolean;
}

export interface BoardView {
  readonly model: BoardModel;
  /** `loading` until the first machine answers; `error` only when every machine failed with nothing to show. */
  readonly status: BoardLoadStatus;
  readonly machines: readonly BoardMachineStatus[];
  /** Reads every machine's whole board now, ahead of the 30-second beat. */
  readonly refresh: () => void;
}

const machineKey = (machines: readonly BoardMachine[]): string => pairingKey(machines.map(m => m.connection));

const summarise = (statuses: readonly BoardMachineStatus[], anyCards: boolean): BoardLoadStatus => {
  if (statuses.length === 0) return 'idle';
  if (statuses.some(status => status.status === 'ready')) return 'ready';
  if (anyCards) return 'ready';
  if (statuses.every(status => status.status === 'error')) return 'error';
  return 'loading';
};

/** The board across every machine in `machines`, narrowed by `filters`. */
export const useBoard = (
  store: DaemonBoardStore,
  machines: readonly BoardMachine[],
  filters: BoardFilters,
  options: { readonly beat?: boolean } = {},
): BoardView => {
  const connections = useMemo(() => machines.map(machine => machine.connection), [machines]);
  const query = useMemo(() => toServerQuery(filters), [filters]);
  const key = boardViewKey(query, connections);
  const now = useNow();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view key is the deliberate dependency
  useEffect(() => store.watch(query, connections, options).release, [store, key]);
  const view = useSyncExternalStore(
    store.subscribe,
    () => store.view(key),
    () => null,
  );
  const names = machineKey(machines);
  // biome-ignore lint/correctness/useExhaustiveDependencies: names are keyed by the pairings
  return useMemo(() => {
    const data: BoardMachineData[] = [];
    const statuses: BoardMachineStatus[] = [];
    for (const { connection, name } of machines) {
      const slice: BoardMachineSlice | undefined = view?.slices.get(connection.daemonId);
      statuses.push({
        daemonId: connection.daemonId,
        machine: name,
        status: slice?.status ?? 'loading',
        error: slice?.error ?? null,
        truncated: slice?.truncated ?? false,
      });
      if (slice === undefined) continue;
      data.push({
        daemonId: connection.daemonId,
        machine: name,
        version: slice.version,
        cards: [...slice.cards.values()],
        laneSets: slice.laneSets,
        counts: slice.counts,
        quarantined: slice.quarantined,
      });
    }
    const model = mergeBoard(data, filters, now);
    return {
      model,
      status: summarise(statuses, model.cards.length > 0),
      machines: statuses,
      refresh: () => {
        for (const { connection } of machines) void store.refresh(key, connection.daemonId);
      },
    };
  }, [view, filters, names, key, store]);
};

/** One card in full, read from the machine that owns it. `machine` is `undefined` once it is unpaired. */
export const useBoardCard = (
  store: DaemonBoardStore,
  machine: DaemonConnection | undefined,
  id: CardId,
  options: { readonly beat?: boolean } = {},
): BoardCardState => {
  const daemonId = machine?.daemonId;
  const beat = options.beat !== false;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairing is the deliberate key
  useEffect(
    () => (machine === undefined ? undefined : store.watchTask(machine, id, { beat })),
    [store, daemonId, id, beat],
  );
  return useSyncExternalStore(
    store.subscribe,
    () => (daemonId === undefined ? IDLE_BOARD_TASK : store.taskState(daemonId, id)),
    () => IDLE_BOARD_TASK,
  );
};

/**
 * Several cards in full, in the order asked for, each read from `machine`. The list is rebuilt only when a
 * card's state changed, so it is as stable as the states in it.
 */
export const useBoardTasks = (
  store: DaemonBoardStore,
  machine: DaemonConnection | undefined,
  ids: readonly CardId[],
  options: { readonly beat?: boolean } = {},
): readonly BoardCardState[] => {
  const daemonId = machine?.daemonId;
  const beat = options.beat !== false;
  const wanted = ids.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairing and the id list are the deliberate key
  useEffect(() => {
    if (machine === undefined) return undefined;
    const releases = ids.map(id => store.watchTask(machine, id, { beat }));
    return () => {
      for (const release of releases) release();
    };
  }, [store, daemonId, wanted, beat]);
  const last = useRef<readonly BoardCardState[]>([]);
  const snapshot = (): readonly BoardCardState[] => {
    const next = ids.map(id => (daemonId === undefined ? IDLE_BOARD_TASK : store.taskState(daemonId, id)));
    const same = next.length === last.current.length && next.every((state, index) => state === last.current[index]);
    if (!same) last.current = next;
    return last.current;
  };
  return useSyncExternalStore(store.subscribe, snapshot, () => NO_TASK_STATES);
};

const NO_TASK_STATES: readonly BoardCardState[] = [];

/** Each machine's projects and lane sets;  */
export const useBoardProjects = (
  store: DaemonBoardStore,
  machines: readonly DaemonConnection[],
): ReadonlyMap<DaemonId, BoardProjectsState> => {
  const key = pairingKey(machines);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairings' facts are the deliberate key
  useEffect(() => {
    const releases = machines.map(machine => store.watchProjects(machine));
    return () => {
      for (const release of releases) release();
    };
  }, [store, key]);
  // The states are identity-stable but a list of them is not, so the store's changes are counted instead.
  const [tick, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => store.subscribe(bump), [store]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the store's change count
  return useMemo(
    () => new Map(machines.map(machine => [machine.daemonId, store.projectsState(machine.daemonId)] as const)),
    [key, tick, store],
  );
};

/** The write verbs, bound to the machines currently paired. */
export const useBoardActions = (store: DaemonBoardStore, machines: readonly DaemonConnection[]): BoardActions => {
  const key = pairingKey(machines);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairings' facts are the deliberate key
  return useMemo(
    () =>
      createBoardActions({
        store,
        connection: daemonId => machines.find(machine => machine.daemonId === daemonId),
      }),
    [store, key],
  );
};

/** The filter set a URL's query names, and the way to write a new one back as a query string. */
export const useBoardFilters = (
  search: string,
  navigate: (search: string) => void,
): readonly [BoardFilters, (next: BoardFilters) => void] => {
  const showPrivate = useSyncExternalStore(boardPrivate.subscribe, boardPrivate.snapshot, () => false);
  const defaults = useMemo(() => ({ agents: showPrivate }), [showPrivate]);
  const filters = useMemo(() => parseBoardFilters(search, defaults), [search, defaults]);
  const set = useCallback(
    (next: BoardFilters) => {
      // Only the toggle itself changes the device's choice: a link that said `agents=1` does not. The toggle
      // writes the choice into the link too (`agents=1`; off is the plain link, as the device now defaults to off).
      const toggled = next.agents !== filters.agents;
      if (toggled) boardPrivate.set(next.agents);
      navigate(boardFiltersToSearch(next, toggled ? undefined : { agents: showPrivate }).toString());
    },
    [filters.agents, navigate, showPrivate],
  );
  return [filters, set];
};
