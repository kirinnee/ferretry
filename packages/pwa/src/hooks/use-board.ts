/**
 * THE BOARD, as hooks the pages build on. No markup here: a page takes a model and draws it.
 *
 *   useBoard(store, machines, filters)   every paired machine's cards, grouped project → lane, with the
 *                                        header's counts; live (`board.changed`) and re-derived every 30s
 *   useBoardTask(store, machine, id)     one card in full, by `(machine, id)`
 *   useBoardProjects(store, machines)    each machine's projects with their lane sets
 *   useBoardActions(store, agenda, ms)   move / reopen / depend / note / link / drop / editField / answer
 *   useBoardFilters(...)                 the filter set read from, and written to, the URL query
 *
 * They take the store and the machines as arguments, like `useProjects`: the page that mounts them says
 * where they read. The filters are the URL's (`project, machine, ferret, kind, pr, state, activity, mine, lane, created, touched`),
 * so a link to a filtered board is the board.
 */

import type { BoardTaskId } from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useReducer, useSyncExternalStore } from 'react';
import type { DaemonAgendaClient } from '../lib/agenda-client.ts';
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
import {
  type BoardLoadStatus,
  type BoardMachineSlice,
  type BoardProjectsState,
  type BoardTaskState,
  boardViewKey,
  type DaemonBoardStore,
  IDLE_BOARD_TASK,
} from '../lib/board-store.ts';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import { pairingKey } from './use-machines-poll.ts';

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
    const model = mergeBoard(data, filters);
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
export const useBoardTask = (
  store: DaemonBoardStore,
  machine: DaemonConnection | undefined,
  id: BoardTaskId,
): BoardTaskState => {
  const daemonId = machine?.daemonId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairing is the deliberate key
  useEffect(
    () => (machine === undefined ? undefined : store.watchTask(machine, id)),
    [store, daemonId, machine?.baseUrl, machine?.deviceId, id],
  );
  return useSyncExternalStore(
    store.subscribe,
    () => (daemonId === undefined ? IDLE_BOARD_TASK : store.taskState(daemonId, id)),
    () => IDLE_BOARD_TASK,
  );
};

/** Each machine's projects and lane sets; a machine that does not serve them reads `served: false`. */
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
export const useBoardActions = (
  store: DaemonBoardStore,
  agenda: Pick<DaemonAgendaClient, 'respond'>,
  machines: readonly DaemonConnection[],
): BoardActions => {
  const key = pairingKey(machines);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairings' facts are the deliberate key
  return useMemo(
    () =>
      createBoardActions({
        store,
        agenda,
        connection: daemonId => machines.find(machine => machine.daemonId === daemonId),
      }),
    [store, agenda, key],
  );
};

/** The filter set a URL's query names, and the way to write a new one back as a query string. */
export const useBoardFilters = (
  search: string,
  navigate: (search: string) => void,
): readonly [BoardFilters, (next: BoardFilters) => void] => {
  const filters = useMemo(() => parseBoardFilters(search), [search]);
  const set = useCallback((next: BoardFilters) => navigate(boardFiltersToSearch(next).toString()), [navigate]);
  return [filters, set];
};
