/**
 * THE BOARD, HELD: every paired machine's cards for the queries open pages are showing, kept fresh by
 * the machine saying what changed.
 *
 * A PAGE WATCHES A QUERY. `watch(query, machines)` reads each machine's board once and holds it until the
 * page lets go; two pages asking the same thing share one view. A machine's slice is its own: cards keyed
 * by task id WITHIN that machine, so `(daemonId, taskId)` is the identity everywhere above this file.
 *
 * LIVE, WITHOUT RE-READING THE BOARD. The daemon publishes `board.changed {projectId, taskIds}` on the
 * fleet feed. `noteEvent` re-reads exactly those cards (`GET /v1/board/tasks/:id`) and drops each into
 * every view it belongs to — or out of those it no longer belongs to, which is how a card moving lanes or
 * closing leaves a filtered board. What an event cannot say is time: a card going stale is no change in
 * any file. So an open page re-reads its whole board every {@link BOARD_DERIVE_MS}, no oftener, and that
 * read also refreshes the header's counts. Nothing here works out liveness; `activity` is the daemon's.
 *
 * READS RACE, AND THE NEWEST ISSUED WINS. A full read, a card read and a write's answer all describe a
 * card at the moment the request was MADE, and they settle in any order. Each is stamped when it is issued;
 * a card keeps the stamp of the last thing that set it, and an older stamp cannot overwrite a newer one —
 * nor can a read that settles after the card was removed bring it back. The test for this is
 * `board-store.test.ts`.
 *
 * A RE-PAIR DROPS A MACHINE. `clearDaemon` forgets every slice of that machine in every view and
 * abandons its reads in flight, so nothing read under a replaced credential is shown or kept.
 */

import {
  BOARD_EVENT_TYPES,
  BoardChangedEventSchema,
  type BoardCounts,
  type BoardProject,
  type BoardProjectId,
  type BoardQuarantinedCard,
  type BoardResult,
  type BoardTaskActionRequestInput,
  type BoardTaskCreateRequestInput,
  type BoardTaskId,
  type BoardTaskResponse,
  type BoardTaskView,
  boardErr,
  boardOk,
  type FyEvent,
  type LaneSet,
  type LaneSetActionRequestInput,
  type LaneSetChangeResponse,
} from '@ferretry/protocol';
import {
  type BoardPort,
  type BoardRead,
  type BoardWriteError,
  type LaneWriteError,
  readWholeBoard,
} from './board-client.ts';
import { type BoardServerQuery, cardMatchesQuery, serverQueryKey } from './board-model.ts';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';

/** The longest an open page goes without re-reading its whole board. */
export const BOARD_DERIVE_MS = 30_000;

export type BoardLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** One machine's part of a view. Immutable: a change replaces it. */
export interface BoardMachineSlice {
  readonly status: BoardLoadStatus;
  readonly error: string | null;
  readonly cards: ReadonlyMap<BoardTaskId, BoardTaskView>;
  readonly laneSets: ReadonlyMap<BoardProjectId, LaneSet | null>;
  readonly counts: BoardCounts | null;
  readonly quarantined: readonly BoardQuarantinedCard[];
  /** The board has more cards than the pages read. */
  readonly truncated: boolean;
  readonly version: string | null;
  /** When the whole board was last read (the store's clock); `null` before the first read. */
  readonly readAt: number | null;
}

export interface BoardViewState {
  readonly key: string;
  readonly query: BoardServerQuery;
  readonly slices: ReadonlyMap<DaemonId, BoardMachineSlice>;
}

export interface BoardTaskState {
  readonly status: BoardLoadStatus;
  readonly error: string | null;
  readonly task: BoardTaskView | null;
  readonly laneSet: LaneSet | null;
  /** The machine answered and has no such card. */
  readonly missing: boolean;
}

export interface BoardProjectsState {
  readonly status: BoardLoadStatus;
  readonly error: string | null;
  /** `null` until read, and when the machine does not serve projects. */
  readonly projects: readonly BoardProject[] | null;
  /** The machine answered `404`: it predates `/v1/board/projects`. */
  readonly served: boolean;
}

/** Every card id one machine holds, for proving a `&F12` reference whatever project the card is on. */
export interface BoardIdsState {
  readonly status: BoardLoadStatus;
  readonly error: string | null;
  /** `null` until read, and when the machine does not serve the list (an older daemon). */
  readonly ids: ReadonlySet<BoardTaskId> | null;
}

/** Timers and the clock, injectable so a suite drives the cadence by hand. */
export interface BoardEnvironment {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  /** A hidden page re-reads nothing; showing it again waits for the next beat. */
  readonly visible: () => boolean;
}

const browserBoardEnvironment: BoardEnvironment = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
};

const IDLE_SLICE: BoardMachineSlice = Object.freeze({
  status: 'idle' as const,
  error: null,
  cards: new Map(),
  laneSets: new Map(),
  counts: null,
  quarantined: [],
  truncated: false,
  version: null,
  readAt: null,
});

export const IDLE_BOARD_TASK: BoardTaskState = Object.freeze({
  status: 'idle' as const,
  error: null,
  task: null,
  laneSet: null,
  missing: false,
});

const IDLE_BOARD_IDS: BoardIdsState = Object.freeze({ status: 'idle' as const, error: null, ids: null });

const IDLE_BOARD_PROJECTS: BoardProjectsState = Object.freeze({
  status: 'idle' as const,
  error: null,
  projects: null,
  served: true,
});

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

interface View {
  readonly key: string;
  readonly query: BoardServerQuery;
  readonly machines: Map<DaemonId, DaemonConnection>;
  refs: number;
  state: BoardViewState;
  timer: unknown;
  /** A watcher wants the whole board re-read every beat. A view nobody asked that of stays live by events alone. */
  beat: boolean;
  /** The stamp of whatever last set (or removed) each card, per machine. */
  readonly stamps: Map<DaemonId, Map<BoardTaskId, number>>;
  /** The stamp of the newest whole-board read applied, per machine. */
  readonly fullStamp: Map<DaemonId, number>;
}

interface TaskWatch {
  readonly daemonId: DaemonId;
  readonly id: BoardTaskId;
  refs: number;
  state: BoardTaskState;
  stamp: number;
  timer: unknown;
}

/** The key of the view for a query over these machines: what `watch` joins and `view` reads. */
export const boardViewKey = (query: BoardServerQuery, machines: readonly DaemonConnection[]): string =>
  JSON.stringify([serverQueryKey(query), machines.map(connectionKey).sort()]);

const connectionKey = (machine: DaemonConnection): string =>
  `${machine.daemonId}\u0000${machine.baseUrl}\u0000${machine.deviceId}`;

const taskKey = (daemonId: DaemonId, id: BoardTaskId): string => JSON.stringify([daemonId, id]);

export class DaemonBoardStore {
  readonly #port: BoardPort;
  readonly #env: BoardEnvironment;
  readonly #views = new Map<string, View>();
  readonly #tasks = new Map<string, TaskWatch>();
  readonly #projects = new Map<DaemonId, BoardProjectsState>();
  readonly #projectRefs = new Map<DaemonId, number>();
  readonly #ids = new Map<DaemonId, BoardIdsState>();
  /** Bumped when a machine is forgotten: a read issued before it publishes nothing. */
  readonly #generations = new Map<DaemonId, number>();
  readonly #connections = new Map<DaemonId, DaemonConnection>();
  readonly #listeners = new Set<() => void>();
  #clock = 0;

  constructor(port: BoardPort, environment: BoardEnvironment = browserBoardEnvironment) {
    this.#port = port;
    this.#env = environment;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // -------------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------------

  /** The view's state, or `null` when no page is watching it. Identity-stable until it changes. */
  view(key: string): BoardViewState | null {
    return this.#views.get(key)?.state ?? null;
  }

  /**
   * Joins the view for a query over these machines, reading each machine that has not been read, and
   * answers the view's key and how to let go. Letting go of the last watcher stops the 30-second re-read
   * and drops the view.
   */
  watch(
    query: BoardServerQuery,
    machines: readonly DaemonConnection[],
    options: { readonly beat?: boolean } = {},
  ): { readonly key: string; release(): void } {
    const key = boardViewKey(query, machines);
    let view = this.#views.get(key);
    if (view === undefined) {
      view = {
        key,
        query,
        machines: new Map(),
        refs: 0,
        state: { key, query, slices: new Map() },
        timer: undefined,
        beat: false,
        stamps: new Map(),
        fullStamp: new Map(),
      };
      this.#views.set(key, view);
    }
    view.refs += 1;
    view.beat ||= options.beat ?? true;
    const joined = view;
    for (const machine of machines) {
      this.#connections.set(machine.daemonId, machine);
      joined.machines.set(machine.daemonId, machine);
      if (this.#slice(joined, machine.daemonId).status === 'idle') void this.#readWhole(joined, machine.daemonId);
    }
    this.#arm(joined);
    let released = false;
    return {
      key,
      release: () => {
        if (released) return;
        released = true;
        joined.refs -= 1;
        if (joined.refs > 0) return;
        if (joined.timer !== undefined) this.#env.clearTimeout(joined.timer);
        joined.timer = undefined;
        if (this.#views.get(key) === joined) this.#views.delete(key);
      },
    };
  }

  /** Re-reads one machine's whole board in a view now, ahead of the 30-second beat. */
  refresh(key: string, daemonId: DaemonId): Promise<void> {
    const view = this.#views.get(key);
    return view === undefined ? Promise.resolve() : this.#readWhole(view, daemonId);
  }

  #slice(view: View, daemonId: DaemonId): BoardMachineSlice {
    return view.state.slices.get(daemonId) ?? IDLE_SLICE;
  }

  #setSlice(view: View, daemonId: DaemonId, slice: BoardMachineSlice): void {
    const slices = new Map(view.state.slices);
    slices.set(daemonId, slice);
    view.state = { key: view.key, query: view.query, slices };
    this.#publish();
  }

  #generation(daemonId: DaemonId): number {
    return this.#generations.get(daemonId) ?? 0;
  }

  /** The whole board of one machine, with its lane sets and version. */
  async #readWhole(view: View, daemonId: DaemonId): Promise<void> {
    const machine = view.machines.get(daemonId);
    if (machine === undefined) return;
    const stamp = ++this.#clock;
    const generation = this.#generation(daemonId);
    const before = this.#slice(view, daemonId);
    if (before.status !== 'ready') this.#setSlice(view, daemonId, { ...before, status: 'loading', error: null });
    try {
      const [read, listed, version] = await Promise.all([
        readWholeBoard(this.#port, machine, view.query),
        this.#port.projects(machine).catch(() => null),
        this.#port.version(machine),
      ]);
      const laneSets = await this.#laneSetsFor(machine, view.query, read, listed);
      if (!this.#publishes(view, daemonId, generation)) return;
      this.#applyWhole(view, daemonId, stamp, read, laneSets, version);
    } catch (reason) {
      if (!this.#publishes(view, daemonId, generation)) return;
      // A failed read never blanks a good board: the cards stay and the page is told the refresh failed.
      const current = this.#slice(view, daemonId);
      this.#setSlice(view, daemonId, { ...current, status: 'error', error: failureMessage(reason) });
    }
    this.#arm(view);
  }

  #publishes(view: View, daemonId: DaemonId, generation: number): boolean {
    return this.#views.get(view.key) === view && this.#generation(daemonId) === generation;
  }

  /**
   * Each project's lane set on this machine: the project's own answer when `/v1/board/projects` is served,
   * the one-project board's when the read was scoped to it, and otherwise one tiny scoped read per
   * project the cards name. A project with no confirmed lanes stays `null` and is shown unplaced.
   */
  async #laneSetsFor(
    machine: DaemonConnection,
    query: BoardServerQuery,
    read: BoardRead,
    listed: readonly BoardProject[] | null,
  ): Promise<ReadonlyMap<BoardProjectId, LaneSet | null>> {
    const laneSets = new Map<BoardProjectId, LaneSet | null>();
    for (const project of listed ?? []) laneSets.set(project.id, project.laneSet);
    const scoped = read.response;
    if (scoped.projectId !== null && scoped.laneSet !== null) laneSets.set(scoped.projectId, scoped.laneSet);
    const missing = [
      ...new Set(scoped.cards.map(card => card.projectId).filter(projectId => !laneSets.has(projectId))),
    ];
    await Promise.all(
      missing.map(async projectId => {
        try {
          const one = await this.#port.board(machine, { ...query, project: projectId, state: 'all' }, undefined, 1);
          laneSets.set(projectId, one.laneSet);
        } catch {
          laneSets.set(projectId, null);
        }
      }),
    );
    return laneSets;
  }

  #applyWhole(
    view: View,
    daemonId: DaemonId,
    stamp: number,
    read: BoardRead,
    laneSets: ReadonlyMap<BoardProjectId, LaneSet | null>,
    version: string | null,
  ): void {
    const stamps = view.stamps.get(daemonId) ?? new Map<BoardTaskId, number>();
    view.stamps.set(daemonId, stamps);
    const current = this.#slice(view, daemonId);
    const cards = new Map(current.cards);
    const incoming = new Set<BoardTaskId>();
    for (const card of read.response.cards) {
      incoming.add(card.id);
      if (stamp > (stamps.get(card.id) ?? 0)) {
        cards.set(card.id, card);
        stamps.set(card.id, stamp);
      }
    }
    // A board that ran past its last page cannot say a card is gone, only that it was not read.
    if (!read.truncated) {
      for (const id of current.cards.keys()) {
        if (!incoming.has(id) && stamp > (stamps.get(id) ?? 0)) {
          cards.delete(id);
          stamps.set(id, stamp);
        }
      }
    }
    view.fullStamp.set(daemonId, Math.max(view.fullStamp.get(daemonId) ?? 0, stamp));
    this.#setSlice(view, daemonId, {
      status: 'ready',
      error: null,
      cards,
      laneSets: new Map([...current.laneSets, ...laneSets]),
      counts: read.response.counts,
      quarantined: read.response.quarantined,
      truncated: read.truncated,
      version,
      readAt: this.#env.now(),
    });
  }

  /** The next whole-board read of a view, one beat after the last; a hidden page waits a beat. */
  #arm(view: View): void {
    if (view.timer !== undefined) this.#env.clearTimeout(view.timer);
    if (!view.beat) return;
    view.timer = this.#env.setTimeout(() => {
      view.timer = undefined;
      if (this.#views.get(view.key) !== view) return;
      if (!this.#env.visible()) {
        this.#arm(view);
        return;
      }
      const reads = [...view.machines.keys()].map(daemonId => this.#readWhole(view, daemonId));
      void Promise.allSettled(reads).then(() => {
        // A view whose every read was abandoned would otherwise never ask again.
        if (this.#views.get(view.key) === view && view.timer === undefined) this.#arm(view);
      });
    }, BOARD_DERIVE_MS);
  }

  // -------------------------------------------------------------------------------------------------
  // Live updates
  // -------------------------------------------------------------------------------------------------

  /**
   * Hands the store one event from a machine's fleet feed. Anything but a well-formed `board.changed` is
   * ignored, and so is one for a machine nothing is watching.
   */
  noteEvent(daemonId: DaemonId, event: Pick<FyEvent, 'type' | 'data'>): void {
    if (event.type !== BOARD_EVENT_TYPES.changed) return;
    const changed = BoardChangedEventSchema.safeParse(event.data);
    if (!changed.success) return;
    this.#noteIds(daemonId, changed.data.taskIds);
    void this.reconcile(daemonId, changed.data.taskIds);
  }

  /** Re-reads these cards of one machine, and only these, into every view and task page that holds them. */
  async reconcile(daemonId: DaemonId, taskIds: readonly BoardTaskId[]): Promise<void> {
    const machine = this.#connections.get(daemonId);
    if (machine === undefined) return;
    const generation = this.#generation(daemonId);
    const watching = [...this.#views.values()].filter(view => view.machines.has(daemonId));
    await Promise.all(
      [...new Set(taskIds)].map(async id => {
        const stamp = ++this.#clock;
        const holders = [...this.#tasks.values()].filter(watch => watch.daemonId === daemonId && watch.id === id);
        if (watching.length === 0 && holders.length === 0) return;
        try {
          const answer = await this.#port.task(machine, id);
          if (this.#generation(daemonId) !== generation) return;
          for (const view of watching)
            if (this.#views.get(view.key) === view) this.#placeCard(view, daemonId, id, stamp, answer);
          for (const watch of holders) this.#setTask(watch, stamp, answer);
        } catch {
          // A failed card read changes nothing; the next beat re-reads the whole board.
        }
      }),
    );
  }

  /** Puts one card read into a view, or takes it out. `answer` is `null` for a card the machine lacks. */
  #placeCard(view: View, daemonId: DaemonId, id: BoardTaskId, stamp: number, answer: BoardTaskResponse | null): void {
    const stamps = view.stamps.get(daemonId) ?? new Map<BoardTaskId, number>();
    view.stamps.set(daemonId, stamps);
    if (stamp <= Math.max(stamps.get(id) ?? 0, view.fullStamp.get(daemonId) ?? 0)) return;
    const current = this.#slice(view, daemonId);
    const laneSets =
      answer?.laneSet == null ? current.laneSets : new Map(current.laneSets).set(answer.task.projectId, answer.laneSet);
    const laneSet = answer === null ? null : (laneSets.get(answer.task.projectId) ?? null);
    const belongs = answer !== null && cardMatchesQuery(answer.task, laneSet, view.query);
    stamps.set(id, stamp);
    const cards = new Map(current.cards);
    if (belongs) cards.set(id, answer.task);
    else cards.delete(id);
    this.#setSlice(view, daemonId, { ...current, cards, laneSets });
  }

  // -------------------------------------------------------------------------------------------------
  // One card
  // -------------------------------------------------------------------------------------------------

  taskState(daemonId: DaemonId, id: BoardTaskId): BoardTaskState {
    return this.#tasks.get(taskKey(daemonId, id))?.state ?? IDLE_BOARD_TASK;
  }

  /** Joins the page for one card, reads it, and re-reads it on its `board.changed` and every beat. */
  watchTask(machine: DaemonConnection, id: BoardTaskId): () => void {
    this.#connections.set(machine.daemonId, machine);
    const key = taskKey(machine.daemonId, id);
    let watch = this.#tasks.get(key);
    if (watch === undefined) {
      watch = { daemonId: machine.daemonId, id, refs: 0, state: IDLE_BOARD_TASK, stamp: 0, timer: undefined };
      this.#tasks.set(key, watch);
    }
    watch.refs += 1;
    const joined = watch;
    if (joined.state.status === 'idle') void this.#readTask(joined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      joined.refs -= 1;
      if (joined.refs > 0) return;
      if (joined.timer !== undefined) this.#env.clearTimeout(joined.timer);
      joined.timer = undefined;
      if (this.#tasks.get(key) === joined) this.#tasks.delete(key);
    };
  }

  async #readTask(watch: TaskWatch): Promise<void> {
    const machine = this.#connections.get(watch.daemonId);
    if (machine === undefined) return;
    const stamp = ++this.#clock;
    const generation = this.#generation(watch.daemonId);
    if (watch.state.status !== 'ready') this.#setTaskState(watch, { ...watch.state, status: 'loading', error: null });
    try {
      const answer = await this.#port.task(machine, watch.id);
      if (
        this.#generation(watch.daemonId) !== generation ||
        this.#tasks.get(taskKey(watch.daemonId, watch.id)) !== watch
      )
        return;
      this.#setTask(watch, stamp, answer);
    } catch (reason) {
      if (
        this.#generation(watch.daemonId) !== generation ||
        this.#tasks.get(taskKey(watch.daemonId, watch.id)) !== watch
      )
        return;
      this.#setTaskState(watch, { ...watch.state, status: 'error', error: failureMessage(reason) });
    }
    this.#armTask(watch);
  }

  #setTask(watch: TaskWatch, stamp: number, answer: BoardTaskResponse | null): void {
    if (stamp <= watch.stamp) return;
    watch.stamp = stamp;
    this.#setTaskState(
      watch,
      answer === null
        ? { status: 'ready', error: null, task: null, laneSet: null, missing: true }
        : { status: 'ready', error: null, task: answer.task, laneSet: answer.laneSet, missing: false },
    );
  }

  #setTaskState(watch: TaskWatch, state: BoardTaskState): void {
    watch.state = state;
    this.#publish();
  }

  #armTask(watch: TaskWatch): void {
    if (watch.timer !== undefined) this.#env.clearTimeout(watch.timer);
    watch.timer = this.#env.setTimeout(() => {
      watch.timer = undefined;
      if (this.#tasks.get(taskKey(watch.daemonId, watch.id)) !== watch) return;
      if (!this.#env.visible()) this.#armTask(watch);
      else void this.#readTask(watch);
    }, BOARD_DERIVE_MS);
  }

  // -------------------------------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------------------------------

  projectsState(daemonId: DaemonId): BoardProjectsState {
    return this.#projects.get(daemonId) ?? IDLE_BOARD_PROJECTS;
  }

  /** Joins one machine's project list, reading it once; a machine that does not serve it says so. */
  watchProjects(machine: DaemonConnection): () => void {
    this.#connections.set(machine.daemonId, machine);
    this.#projectRefs.set(machine.daemonId, (this.#projectRefs.get(machine.daemonId) ?? 0) + 1);
    if (this.projectsState(machine.daemonId).status === 'idle') void this.refreshProjects(machine);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#projectRefs.set(machine.daemonId, Math.max(0, (this.#projectRefs.get(machine.daemonId) ?? 1) - 1));
    };
  }

  async refreshProjects(machine: DaemonConnection): Promise<void> {
    const { daemonId } = machine;
    const generation = this.#generation(daemonId);
    const before = this.projectsState(daemonId);
    if (before.status !== 'ready') this.#setProjects(daemonId, { ...before, status: 'loading', error: null });
    try {
      const projects = await this.#port.projects(machine);
      if (this.#generation(daemonId) !== generation) return;
      this.#setProjects(daemonId, { status: 'ready', error: null, projects, served: projects !== null });
    } catch (reason) {
      if (this.#generation(daemonId) !== generation) return;
      this.#setProjects(daemonId, { ...this.projectsState(daemonId), status: 'error', error: failureMessage(reason) });
    }
  }

  #setProjects(daemonId: DaemonId, state: BoardProjectsState): void {
    this.#projects.set(daemonId, state);
    this.#publish();
  }

  // -------------------------------------------------------------------------------------------------
  // Card ids
  // -------------------------------------------------------------------------------------------------

  idsState(daemonId: DaemonId): BoardIdsState {
    return this.#ids.get(daemonId) ?? IDLE_BOARD_IDS;
  }

  /**
   * Joins one machine's card-id list, reading it once. It is the proof behind `&F12` on every project, so it
   * is never narrowed to a view's query; `board.changed` adds the ids it names, so a card made a moment ago
   * is proved without a re-read.
   */
  watchIds(machine: DaemonConnection): void {
    this.#connections.set(machine.daemonId, machine);
    const { status } = this.idsState(machine.daemonId);
    if (status === 'idle' || status === 'error') void this.refreshIds(machine);
  }

  async refreshIds(machine: DaemonConnection): Promise<void> {
    const { daemonId } = machine;
    const generation = this.#generation(daemonId);
    const before = this.idsState(daemonId);
    if (before.status === 'loading') return;
    this.#setIds(daemonId, { ...before, status: 'loading', error: null });
    try {
      const listed = await this.#port.ids(machine);
      if (this.#generation(daemonId) !== generation) return;
      this.#setIds(daemonId, { status: 'ready', error: null, ids: listed === null ? null : new Set(listed) });
    } catch (reason) {
      if (this.#generation(daemonId) !== generation) return;
      this.#setIds(daemonId, { ...this.idsState(daemonId), status: 'error', error: failureMessage(reason) });
    }
  }

  #noteIds(daemonId: DaemonId, taskIds: readonly BoardTaskId[]): void {
    const current = this.idsState(daemonId);
    if (current.ids === null || taskIds.every(id => current.ids?.has(id) === true)) return;
    this.#setIds(daemonId, { ...current, ids: new Set([...current.ids, ...taskIds]) });
  }

  #setIds(daemonId: DaemonId, state: BoardIdsState): void {
    this.#ids.set(daemonId, state);
    this.#publish();
  }

  // -------------------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------------------

  /**
   * Sends one action to the machine that owns the card and, when the daemon accepts it, puts the card as
   * the daemon now holds it into every view and page showing it — without waiting for the feed to say so.
   * A refusal changes nothing and comes back as a value.
   */
  async act(
    machine: DaemonConnection,
    id: BoardTaskId,
    request: BoardTaskActionRequestInput,
  ): Promise<BoardResult<BoardTaskView, BoardWriteError>> {
    const generation = this.#generation(machine.daemonId);
    const stamp = ++this.#clock;
    const answer = await this.#port.act(machine, id, request);
    if (!answer.ok) return boardErr(answer.error);
    // The answer was made after the request, so it outranks anything stamped before it settled.
    const settled = ++this.#clock;
    void stamp;
    if (this.#generation(machine.daemonId) === generation) {
      for (const view of this.#views.values()) {
        if (view.machines.has(machine.daemonId)) this.#placeCard(view, machine.daemonId, id, settled, answer.value);
      }
      for (const watch of this.#tasks.values()) {
        if (watch.daemonId === machine.daemonId && watch.id === id) this.#setTask(watch, settled, answer.value);
      }
    }
    return boardOk(answer.value.task);
  }

  /**
   * Opens a card the owner wrote on `machine` and, when the daemon accepts it, puts it into every view
   * and page showing that machine, like an accepted action does.
   */
  async create(
    machine: DaemonConnection,
    request: BoardTaskCreateRequestInput,
  ): Promise<BoardResult<BoardTaskView, BoardWriteError>> {
    const generation = this.#generation(machine.daemonId);
    const answer = await this.#port.create(machine, request);
    if (!answer.ok) return boardErr(answer.error);
    const settled = ++this.#clock;
    if (this.#generation(machine.daemonId) === generation) {
      for (const view of this.#views.values()) {
        if (view.machines.has(machine.daemonId)) {
          this.#placeCard(view, machine.daemonId, answer.value.task.id, settled, answer.value);
        }
      }
    }
    return boardOk(answer.value.task);
  }

  /**
   * Proposes, edits or confirms one project's lanes on the machine that owns them and, when the daemon
   * accepts it, puts the set as the daemon now holds it into the project list and every board showing the
   * project. A refusal changes nothing and comes back as a value.
   */
  async changeLanes(
    machine: DaemonConnection,
    projectId: BoardProjectId,
    request: LaneSetActionRequestInput,
  ): Promise<BoardResult<LaneSetChangeResponse, LaneWriteError>> {
    const { daemonId } = machine;
    const generation = this.#generation(daemonId);
    const answer = await this.#port.lanes(machine, projectId, request);
    if (!answer.ok || this.#generation(daemonId) !== generation) return answer;
    const { laneSet } = answer.value;
    const listed = this.projectsState(daemonId);
    if (listed.projects !== null) {
      this.#projects.set(daemonId, {
        ...listed,
        projects: listed.projects.map(project => (project.id === projectId ? { ...project, laneSet } : project)),
      });
    }
    for (const view of this.#views.values()) {
      const slice = view.state.slices.get(daemonId);
      if (view.machines.has(daemonId) && slice !== undefined) {
        this.#setSlice(view, daemonId, { ...slice, laneSets: new Map(slice.laneSets).set(projectId, laneSet) });
      }
    }
    this.#publish();
    return answer;
  }

  // -------------------------------------------------------------------------------------------------
  // Forgetting
  // -------------------------------------------------------------------------------------------------

  /** Drops one machine from every view and page, and abandons what it was still being asked. */
  clearDaemon(daemonId: DaemonId): void {
    this.#generations.set(daemonId, this.#generation(daemonId) + 1);
    this.#connections.delete(daemonId);
    this.#projects.delete(daemonId);
    this.#ids.delete(daemonId);
    for (const view of this.#views.values()) {
      view.machines.delete(daemonId);
      view.stamps.delete(daemonId);
      view.fullStamp.delete(daemonId);
      const slices = new Map(view.state.slices);
      slices.delete(daemonId);
      view.state = { key: view.key, query: view.query, slices };
    }
    for (const [key, watch] of this.#tasks) {
      if (watch.daemonId !== daemonId) continue;
      if (watch.timer !== undefined) this.#env.clearTimeout(watch.timer);
      this.#tasks.delete(key);
    }
    this.#publish();
  }

  #publish(): void {
    for (const listener of this.#listeners) listener();
  }
}
