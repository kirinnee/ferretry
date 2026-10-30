import {
  type AgendaActionRequest,
  AgendaActionRequestSchema,
  type AgendaCountResponse,
  type AgendaResponse,
  type AgendaSnapshot,
  AgendaSnapshotSchema,
  FY_REQUEST_ID_HEADER,
} from '@ferretry/protocol';
import { type AgendaWire, AgendaWireDirectory, sessionAgendaPath, sessionAgendaRepliesPath } from './agenda-wire.ts';
import { DaemonAgendaStore } from './agenda-store.ts';
import { ConcurrencyLimit } from './concurrency-limit.ts';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';
import { daemonRequest } from './daemon-transport.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from './runtime-models.ts';

const assertScopeDaemon = (daemon: DaemonConnection, scope: DaemonSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('attention scope must belong to the requested daemon');
};

const responseError = async (response: Response): Promise<DaemonResponseError> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
  return new DaemonResponseError(
    response.status,
    typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
    typeof body.code === 'string' ? body.code : undefined,
  );
};

const parseSnapshot = (scope: DaemonSessionScope, value: unknown): AgendaSnapshot => {
  const snapshot = AgendaSnapshotSchema.parse(value);
  if (snapshot.sessionId !== scope.sessionId) throw new DaemonResponseError(502, 'daemon returned another session');
  return snapshot;
};

const fetchAgenda = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  path: string,
  init: RequestInit,
  fetcher: DaemonFetch,
): Promise<unknown> => {
  assertScopeDaemon(daemon, scope);
  const request = daemonRequest(daemon, path, init);
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return await response.json();
};

/** Reads the complete agenda board from exactly the daemon that owns the scope. */
export const fetchAgendaSnapshot = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = browserFetch,
  wire: AgendaWire = 'attention',
): Promise<AgendaSnapshot> =>
  parseSnapshot(scope, await fetchAgenda(daemon, scope, sessionAgendaPath(scope.sessionId, wire), {}, fetcher));

/**
 * Reads the mounted full snapshot route and derives its count for a badge
 * without implying that the complete board was loaded into the store.
 */
export const fetchAgendaCount = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = browserFetch,
  wire: AgendaWire = 'attention',
): Promise<AgendaCountResponse> => {
  const snapshot = await fetchAgendaSnapshot(daemon, scope, fetcher, wire);
  return { sessionId: snapshot.sessionId, count: snapshot.count };
};

/** Applies one protocol-validated board mutation and returns the daemon's authoritative snapshot. */
export const applyAgendaAction = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  action: AgendaActionRequest,
  fetcher: DaemonFetch = browserFetch,
  wire: AgendaWire = 'attention',
): Promise<AgendaSnapshot> => {
  const body = AgendaActionRequestSchema.parse(action);
  const value = await fetchAgenda(
    daemon,
    scope,
    sessionAgendaPath(scope.sessionId, wire),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
      body: JSON.stringify(body),
    },
    fetcher,
  );
  return parseSnapshot(scope, value);
};

/** "Send now": the daemon delivers the answers it is holding at once and returns the board without `replies`. */
export const sendAgendaReplies = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = browserFetch,
  wire: AgendaWire = 'attention',
): Promise<AgendaSnapshot> =>
  parseSnapshot(
    scope,
    await fetchAgenda(
      daemon,
      scope,
      sessionAgendaRepliesPath(scope.sessionId, wire),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
        body: '{}',
      },
      fetcher,
    ),
  );

/**
 * How many boards one daemon is asked for at once.
 *
 * THE INBOX READS ONE BOARD PER SESSION THAT HAS AN OPEN ITEM, across the daemon's whole session list —
 * finished children included — and it used to fire them all in one tick. On a busy machine that was
 * dozens of reads queued on the one relay session every panel shares, which ended that session for every
 * caller (`4400`, "too many records waiting on credit") and painted "Tasks are unavailable" on a surface
 * that had asked for nothing unusual. Four keeps the inbox filling quickly and leaves the rest of the
 * daemon's sixteen request slots to the panels a person is looking at.
 */
export const AGENDA_READS_PER_DAEMON = 4;

interface ConnectionBinding {
  readonly baseUrl: string;
  readonly deviceId: string;
  readonly generation: number;
}

interface InFlight<Value> {
  readonly generation: number;
  readonly promise: Promise<Value>;
}

/**
 * Daemon-scoped attention coordinator. It keeps request coalescing out of the
 * immutable store and fences every continuation by the concrete paired
 * connection: a same-id re-pair or unpair cannot publish stale daemon data.
 */
export class DaemonAgendaClient {
  readonly #fullInFlight = new Map<string, InFlight<void>>();
  readonly #countInFlight = new Map<string, InFlight<void>>();
  /** Settled-only tails: full reads wait for every write already chained here. */
  readonly #mutationTails = new Map<string, InFlight<void>>();
  readonly #bindings = new Map<DaemonId, ConnectionBinding>();
  readonly #generations = new Map<DaemonId, number>();
  /** Board freshness only: badge reads observe it but may never advance it. */
  readonly #boardRevisions = new Map<string, number>();
  /** Board reads in flight, bounded per daemon: see {@link AGENDA_READS_PER_DAEMON}. */
  readonly #reads = new Map<DaemonId, ConcurrencyLimit>();

  constructor(
    readonly store: DaemonAgendaStore = new DaemonAgendaStore(),
    private readonly fetcher: DaemonFetch = browserFetch,
    /** Which spelling each machine speaks; a machine nobody has read health for is spoken to the older way. */
    readonly wires: AgendaWireDirectory = new AgendaWireDirectory(),
  ) {}

  hydrate(daemon: DaemonConnection, scope: DaemonSessionScope): Promise<void> {
    return this.#load(daemon, scope, false);
  }

  /** Refreshes a complete board even when this session is already hydrated. */
  revalidate(daemon: DaemonConnection, scope: DaemonSessionScope): Promise<void> {
    return this.#load(daemon, scope, true);
  }

  #load(daemon: DaemonConnection, scope: DaemonSessionScope, revalidate: boolean): Promise<void> {
    assertScopeDaemon(daemon, scope);
    const generation = this.#bind(daemon);
    const key = daemonSessionKey(scope);
    const existing = this.#fullInFlight.get(key);
    if (existing?.generation === generation) return existing.promise;
    if (!revalidate && this.store.status(scope) === 'ready') return Promise.resolve();

    const promise = this.#loadAfterMutations(daemon, scope, generation, key).finally(() => {
      if (this.#fullInFlight.get(key)?.promise === promise) this.#fullInFlight.delete(key);
    });
    this.#fullInFlight.set(key, { generation, promise });
    return promise;
  }

  #loadAfterMutations(
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    generation: number,
    key: string,
  ): Promise<void> {
    const mutation = this.#mutationTails.get(key);
    if (mutation?.generation === generation) {
      // Re-check after this tail: another write may have joined while the read
      // was queued, and it must settle before the GET is allowed to start too.
      return mutation.promise.then(() => this.#loadAfterMutations(daemon, scope, generation, key));
    }
    return this.#loadNow(daemon, scope, generation, key);
  }

  #loadNow(daemon: DaemonConnection, scope: DaemonSessionScope, generation: number, key: string): Promise<void> {
    // A queued read from an unpaired or same-id re-paired connection has no
    // authority to issue transport after its mutation releases the queue.
    if (!this.#currentConnection(daemon, generation)) return Promise.resolve();
    const revision = this.#advanceBoardRevision(key);
    // A live refresh must not replace an already usable board with a loading
    // state. Initial hydration and retries still expose that they are loading.
    if (this.store.status(scope) !== 'ready') this.store.beginLoad(scope);
    // Asked again once a slot is free, for the reason it is asked above: a read that waited behind others
    // may reach its turn after the machine was unpaired or re-paired, and then it sends nothing at all.
    // The wire is read when the slot comes, so a health answer that arrived meanwhile picks the route.
    const promise = this.#readLimit(daemon.daemonId)
      .run(async () =>
        this.#currentConnection(daemon, generation)
          ? await fetchAgendaSnapshot(daemon, scope, this.fetcher, this.wires.wireOf(daemon.daemonId))
          : null,
      )
      .then(snapshot => {
        if (snapshot !== null && this.#current(daemon, generation, key, revision)) {
          this.#advanceBoardRevision(key);
          this.store.applySnapshot(scope, snapshot);
        }
      })
      .catch(error => {
        if (this.#current(daemon, generation, key, revision)) this.store.fail(scope);
        throw error;
      });
    return promise;
  }

  #readLimit(daemonId: DaemonId): ConcurrencyLimit {
    const existing = this.#reads.get(daemonId);
    if (existing !== undefined) return existing;
    const limit = new ConcurrencyLimit(AGENDA_READS_PER_DAEMON);
    this.#reads.set(daemonId, limit);
    return limit;
  }

  hydrateCount(daemon: DaemonConnection, scope: DaemonSessionScope): Promise<void> {
    assertScopeDaemon(daemon, scope);
    const generation = this.#bind(daemon);
    const key = daemonSessionKey(scope);
    if (this.store.count(scope) !== undefined) return Promise.resolve();
    const existing = this.#countInFlight.get(key);
    if (existing?.generation === generation) return existing.promise;

    const revision = this.#boardRevisions.get(key) ?? 0;
    const promise = fetchAgendaCount(daemon, scope, this.fetcher, this.wires.wireOf(daemon.daemonId))
      .then(count => {
        if (this.#current(daemon, generation, key, revision)) this.store.applyCount(scope, count);
      })
      .finally(() => {
        if (this.#countInFlight.get(key)?.promise === promise) this.#countInFlight.delete(key);
      });
    this.#countInFlight.set(key, { generation, promise });
    return promise;
  }

  resolve(daemon: DaemonConnection, scope: DaemonSessionScope, id: string, note?: string): Promise<void> {
    return this.#mutate(daemon, scope, { action: 'resolve', id, ...(note === undefined ? {} : { note }) });
  }

  respond(
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    id: string,
    response: AgendaResponse,
    note?: string,
  ): Promise<void> {
    return this.#mutate(daemon, scope, { action: 'resolve', id, response, ...(note === undefined ? {} : { note }) });
  }

  dismiss(daemon: DaemonConnection, scope: DaemonSessionScope, id: string, note?: string): Promise<void> {
    return this.#mutate(daemon, scope, { action: 'dismiss', id, ...(note === undefined ? {} : { note }) });
  }

  /** Ticks (or unticks) one 0-based step of an item's checklist; every device sees it. */
  progress(
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    id: string,
    step: number,
    done: boolean,
  ): Promise<void> {
    return this.#mutate(daemon, scope, { action: 'progress', id, step, done });
  }

  /** Tells the ferret a to-do needs more information; the item stays open, waiting on it. */
  needsInfo(daemon: DaemonConnection, scope: DaemonSessionScope, id: string, note?: string): Promise<void> {
    return this.#mutate(daemon, scope, { action: 'needs-info', id, ...(note === undefined ? {} : { note }) });
  }

  /** Asks the ferret to talk an item through before the owner answers; the item stays open, "in discussion". */
  discuss(daemon: DaemonConnection, scope: DaemonSessionScope, id: string, note?: string): Promise<void> {
    return this.#mutate(daemon, scope, { action: 'discuss', id, ...(note === undefined ? {} : { note }) });
  }

  /** Parks an item until `until` (an instant): it leaves the owner's list and comes back on its own. */
  snooze(daemon: DaemonConnection, scope: DaemonSessionScope, id: string, until: string): Promise<void> {
    return this.#mutate(daemon, scope, { action: 'snooze', id, until });
  }

  /** Puts a parked item (snoozed or replied) back on the owner's list now. */
  unsnooze(daemon: DaemonConnection, scope: DaemonSessionScope, id: string): Promise<void> {
    return this.#mutate(daemon, scope, { action: 'unsnooze', id });
  }

  /** Unpair one daemon without perturbing any other daemon's cache or work. */
  clearDaemon(daemonId: DaemonId): void {
    this.#generations.set(daemonId, (this.#generations.get(daemonId) ?? 0) + 1);
    this.#bindings.delete(daemonId);
    this.store.clearDaemon(daemonId);
    this.#clearInFlight(this.#fullInFlight, daemonId);
    this.#clearInFlight(this.#countInFlight, daemonId);
    this.#clearInFlight(this.#mutationTails, daemonId);
    this.#clearBoardRevisions(daemonId);
  }

  /** Delivers the answers the daemon is holding for this ferret now. */
  sendReplies(daemon: DaemonConnection, scope: DaemonSessionScope): Promise<void> {
    return this.#mutate(daemon, scope, () =>
      sendAgendaReplies(daemon, scope, this.fetcher, this.wires.wireOf(daemon.daemonId)),
    );
  }

  #mutate(
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    action: AgendaActionRequest | (() => Promise<AgendaSnapshot>),
  ): Promise<void> {
    assertScopeDaemon(daemon, scope);
    const generation = this.#bind(daemon);
    const key = daemonSessionKey(scope);
    const revision = this.#advanceBoardRevision(key);
    const promise = (
      typeof action === 'function'
        ? action()
        : applyAgendaAction(daemon, scope, action, this.fetcher, this.wires.wireOf(daemon.daemonId))
    )
      .then(snapshot => {
        if (this.#current(daemon, generation, key, revision)) {
          this.#advanceBoardRevision(key);
          this.store.applySnapshot(scope, snapshot);
        }
      })
      .catch(error => {
        if (this.#current(daemon, generation, key, revision)) this.store.fail(scope);
        throw error;
      });
    this.#trackMutation(key, generation, promise);
    return promise;
  }

  #trackMutation(key: string, generation: number, operation: Promise<void>): void {
    const previous = this.#mutationTails.get(key);
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    const tail =
      previous?.generation === generation ? Promise.all([previous.promise, settled]).then(() => undefined) : settled;
    this.#mutationTails.set(key, { generation, promise: tail });
    void tail.then(() => {
      if (this.#mutationTails.get(key)?.promise === tail) this.#mutationTails.delete(key);
    });
  }

  #bind(daemon: DaemonConnection): number {
    const existing = this.#bindings.get(daemon.daemonId);
    if (existing && existing.baseUrl === daemon.baseUrl && existing.deviceId === daemon.deviceId)
      return existing.generation;
    if (existing) this.clearDaemon(daemon.daemonId);
    const generation = this.#generations.get(daemon.daemonId) ?? 0;
    this.#bindings.set(daemon.daemonId, { baseUrl: daemon.baseUrl, deviceId: daemon.deviceId, generation });
    return generation;
  }

  #advanceBoardRevision(key: string): number {
    const revision = (this.#boardRevisions.get(key) ?? 0) + 1;
    this.#boardRevisions.set(key, revision);
    return revision;
  }

  #current(daemon: DaemonConnection, generation: number, key: string, revision: number): boolean {
    return this.#currentConnection(daemon, generation) && (this.#boardRevisions.get(key) ?? 0) === revision;
  }

  #currentConnection(daemon: DaemonConnection, generation: number): boolean {
    const binding = this.#bindings.get(daemon.daemonId);
    return (
      binding !== undefined &&
      binding.generation === generation &&
      binding.baseUrl === daemon.baseUrl &&
      binding.deviceId === daemon.deviceId
    );
  }

  #clearInFlight<Value>(inFlight: Map<string, InFlight<Value>>, daemonId: DaemonId): void {
    for (const key of inFlight.keys()) {
      const [candidate] = JSON.parse(key) as [string, string];
      if (candidate === daemonId) inFlight.delete(key);
    }
  }

  #clearBoardRevisions(daemonId: DaemonId): void {
    for (const key of this.#boardRevisions.keys()) {
      const [candidate] = JSON.parse(key) as [string, string];
      if (candidate === daemonId) this.#boardRevisions.delete(key);
    }
  }
}
