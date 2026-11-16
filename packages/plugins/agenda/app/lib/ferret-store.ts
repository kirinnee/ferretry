/**
 * THE FERRETS THE INBOX COUNTS ON, for the one machine this half's client reaches: Ferrets' list joined with the
 * Agenda's own roll-up of every ferret's open and parked items (`ferret-view.ts`). Today the shell's fleet store held
 * every paired machine's session list with each session's agenda summary; this store is the same shape for one
 * machine (`getSnapshot().daemons`), so the inbox above it reads it unchanged.
 *
 * Ferrets' list is read on demand and again when Ferrets says a ferret changed; the roll-up is read again when Asks
 * says an ask changed. Both reads are coalesced (`ListRefresh`), so a burst of changes is one read.
 */

import type { AgendaRollupStore, RollupSnapshot } from './agenda-rollup.ts';
import { type AgendaCall, agendaCall } from './agenda-call.ts';
import { FERRETS_LIST } from './agenda-wire.ts';
import { type FerretView, type ListedFerret, ferretViews, parseFerretList } from './ferret-view.ts';
import type { DaemonConnection, DaemonId } from './machine.ts';
import { ListRefresh, type ListRefreshEnvironment, browserListRefreshEnvironment } from '../shell.ts';

/** One machine's ferrets as the inbox reads them: `null` until the first list read answers. */
export interface FleetMachine {
  readonly sessions: readonly FerretView[] | null;
}

export interface FleetSnapshot {
  readonly daemons: ReadonlyMap<DaemonId, FleetMachine>;
}

/** The store shape the inbox subscribes to (`useSyncExternalStore`). */
export interface DaemonFleetStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => FleetSnapshot;
}

/** How soon a change is read again: quick enough to feel live, slow enough that a burst is one read. */
const FERRET_REFRESH_MIN_MS = 1_000;

export class AgendaFerretStore implements DaemonFleetStore {
  readonly #listeners = new Set<() => void>();
  readonly #list: ListRefresh<void>;
  readonly #rollupRead: ListRefresh<void>;
  #rows: readonly ListedFerret[] | null = null;
  #rollup: RollupSnapshot;
  #snapshot: FleetSnapshot;

  constructor(
    private readonly client: AgendaCall,
    private readonly connection: DaemonConnection,
    rollup: AgendaRollupStore,
    environment: ListRefreshEnvironment = browserListRefreshEnvironment,
  ) {
    this.#rollup = rollup.getSnapshot();
    this.#snapshot = this.#build();
    this.#list = new ListRefresh(() => this.#readList(), environment, FERRET_REFRESH_MIN_MS);
    this.#rollupRead = new ListRefresh(() => rollup.read(connection), environment, FERRET_REFRESH_MIN_MS);
    rollup.subscribe(() => {
      this.#rollup = rollup.getSnapshot();
      this.#publish();
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#rows === null) void this.refresh();
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): FleetSnapshot => this.#snapshot;

  /** Reads Ferrets' list and the roll-up (each at most once per {@link FERRET_REFRESH_MIN_MS}). */
  refresh(): Promise<void> {
    return Promise.all([this.#list.request(), this.#rollupRead.request()]).then(() => undefined);
  }

  /** A ferret was started, renamed or stopped: its list row moved. */
  ferretChanged(): void {
    void this.#list.invalidate().catch(() => undefined);
  }

  /** An ask moved: the summaries the inbox counts are re-read from the roll-up. */
  askChanged(): void {
    void this.#rollupRead.invalidate().catch(() => undefined);
  }

  stop(): void {
    this.#list.stop();
    this.#rollupRead.stop();
  }

  async #readList(): Promise<void> {
    try {
      this.#rows = parseFerretList(await agendaCall(this.client, FERRETS_LIST));
    } catch {
      // A list that could not be read keeps the last good one; the first failure shows the ferrets the roll-up names.
      this.#rows ??= [];
    }
    this.#publish();
  }

  #build(): FleetSnapshot {
    const boards = this.#rollup.boards.get(this.connection.daemonId) ?? new Map();
    const sessions = this.#rows === null ? null : ferretViews(this.#rows, boards);
    return { daemons: new Map([[this.connection.daemonId, { sessions }]]) };
  }

  #publish(): void {
    this.#snapshot = this.#build();
    for (const listener of this.#listeners) listener();
  }
}
