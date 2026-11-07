import { DaemonAgendaSchema, DaemonAgendaActionSchema } from '../../contract/index.ts';
import {
  AGENDA_CHANNEL_HEADER,
  AGENDA_CHANNEL_VERSION,
  type AgendaActionRequest,
  AgendaActionRequestSchema,
  type AgendaConversationEntry,
  AgendaConversationPageSchema,
  type AgendaCountResponse,
  type AgendaId,
  type AgendaResponse,
  AgendaSeenResponseSchema,
  type AgendaListSnapshot as AgendaSnapshot,
  AgendaListSnapshotSchema as AgendaSnapshotSchema,
  type AgendaVersion,
  type AgendaVersionList,
  AgendaVersionListSchema,
  AgendaVersionSchema,
  type BoardReopenAttachments,
  isMachineAgendaId,
} from '../wire/index.ts';
import { type FyEvent, FY_REQUEST_ID_HEADER } from '../shell.ts';
import { AgendaRollupStore } from './agenda-rollup.ts';
import { DaemonAgendaStore } from './agenda-store.ts';
import { sessionAgendaPath, sessionAgendaRepliesPath } from './agenda-wire.ts';
import { ConcurrencyLimit } from '../shell.ts';
import { ListRefresh, type ListRefreshEnvironment, browserListRefreshEnvironment } from '../shell.ts';
import type { DaemonConnection, DaemonId } from '../shell.ts';
import { type DaemonSessionScope, daemonSessionKey } from '../shell.ts';
import { daemonRequest } from '../shell.ts';
import { browserFetch, type DaemonFetch, DaemonResponseError } from '../shell.ts';

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
  const snapshot = (isMachineAgendaId(scope.sessionId) ? DaemonAgendaSchema : AgendaSnapshotSchema).parse(value);
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
  // The machine board has only owner list/actions routes. Versions, conversation, seen and held replies belong
  // to session boards; never turn an unsupported machine operation into a session request for its reserved id.
  if (isMachineAgendaId(scope.sessionId) && path !== '/v1/machine/agenda')
    throw new DaemonResponseError(404, 'this operation is unavailable on /v1/machine/agenda', 'not-found');
  const headers = new Headers(init.headers);
  headers.set(AGENDA_CHANNEL_HEADER, AGENDA_CHANNEL_VERSION);
  const request = daemonRequest(daemon, path, { ...init, headers });
  const response = await fetcher(request.url, request.init);
  if (!response.ok) throw await responseError(response);
  return await response.json();
};

/** Reads the complete agenda board from exactly the daemon that owns the scope. */
export const fetchAgendaSnapshot = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = browserFetch,
): Promise<AgendaSnapshot> =>
  parseSnapshot(
    scope,
    await (isMachineAgendaId(scope.sessionId)
      ? fetchAgenda(daemon, scope, '/v1/machine/agenda', { method: 'GET' }, fetcher)
      : fetchAgenda(daemon, scope, sessionAgendaPath(scope.sessionId), {}, fetcher)),
  );

/**
 * Reads the mounted full snapshot route and derives its count for a badge
 * without implying that the complete board was loaded into the store.
 */
export const fetchAgendaCount = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = browserFetch,
): Promise<AgendaCountResponse> => {
  const snapshot = await fetchAgendaSnapshot(daemon, scope, fetcher);
  return { sessionId: snapshot.sessionId, count: snapshot.count };
};

/** Applies one protocol-validated board mutation and returns the daemon's authoritative snapshot. */
export const applyAgendaAction = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  action: AgendaActionRequest,
  fetcher: DaemonFetch = browserFetch,
): Promise<AgendaSnapshot> => {
  const body = (isMachineAgendaId(scope.sessionId) ? DaemonAgendaActionSchema : AgendaActionRequestSchema).parse(
    action,
  );
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
    body: JSON.stringify(body),
  };
  const value = await (isMachineAgendaId(scope.sessionId)
    ? fetchAgenda(daemon, scope, '/v1/machine/agenda', init, fetcher)
    : fetchAgenda(daemon, scope, sessionAgendaPath(scope.sessionId), init, fetcher));
  return parseSnapshot(scope, value);
};

/** "Send now": the daemon delivers the answers it is holding at once and returns the board without `replies`. */
export const sendAgendaReplies = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  fetcher: DaemonFetch = browserFetch,
): Promise<AgendaSnapshot> =>
  parseSnapshot(
    scope,
    await fetchAgenda(
      daemon,
      scope,
      sessionAgendaRepliesPath(scope.sessionId),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [FY_REQUEST_ID_HEADER]: crypto.randomUUID() },
        body: '{}',
      },
      fetcher,
    ),
  );

const itemVersionsPath = (sessionId: string, id: AgendaId): string =>
  `/v1/ferrets/${encodeURIComponent(sessionId)}/agenda/${encodeURIComponent(id)}/versions`;

/**
 * Every version an item has been kept as, with the one this device last opened.
 */
export const fetchAgendaVersions = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  id: AgendaId,
  fetcher: DaemonFetch = browserFetch,
): Promise<AgendaVersionList> =>
  AgendaVersionListSchema.parse(
    await fetchAgenda(daemon, scope, itemVersionsPath(scope.sessionId, id), { method: 'GET' }, fetcher),
  );

/** One whole version of an item, as it was left. */
export const fetchAgendaVersion = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  id: AgendaId,
  version: number,
  fetcher: DaemonFetch = browserFetch,
): Promise<AgendaVersion> =>
  AgendaVersionSchema.parse(
    await fetchAgenda(daemon, scope, `${itemVersionsPath(scope.sessionId, id)}/${version}`, { method: 'GET' }, fetcher),
  );

/** The most fragment reads one call takes: a runaway cursor ends the read instead of looping. */
export const MAX_CONVERSATION_FRAGMENTS = 2_000;

/** Which entries of the stored conversation to read: `from` up to (not including) `until`, of the current thread or a frozen `version`. */
export interface AgendaConversationRange {
  readonly version?: number;
  readonly from?: number;
  readonly until?: number;
}

/** What a conversation read got: the entries read whole, and whether it stopped at its read limit before the end. */
export interface AgendaConversationRead {
  /** The entries from `from`, each read WHOLE and in order; an entry the read stopped inside is not among them. */
  readonly entries: readonly AgendaConversationEntry[];
  /** The read hit {@link MAX_CONVERSATION_FRAGMENTS} before it reached `until` or the end: more is still unread. */
  readonly capped: boolean;
}

/**
 * The item's stored conversation, oldest first, read through `GET …/conversation` in its
 * bounded fragments, each entry's fragments joined verbatim. The item itself carries only a recent tail, so a reader
 * asks for the entries before it (`until`) and, on a later read, only the entries it does not have yet (`from`).
 * A read that stops at its limit SAYS so (`capped`) and never hands back a partial entry as a whole one.
 */
export const fetchAgendaConversation = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  id: AgendaId,
  range: AgendaConversationRange = {},
  fetcher: DaemonFetch = browserFetch,
): Promise<AgendaConversationRead> => {
  const base = `/v1/ferrets/${encodeURIComponent(scope.sessionId)}/agenda/${encodeURIComponent(id)}/conversation`;
  const from = range.from ?? 0;
  const until = range.until ?? Number.POSITIVE_INFINITY;
  const entries: AgendaConversationEntry[] = [];
  let cursor: { readonly index: number; readonly offset: number } | undefined = { index: from, offset: 0 };
  let reads = 0;
  while (cursor !== undefined && cursor.index < until && reads < MAX_CONVERSATION_FRAGMENTS) {
    const query = new URLSearchParams({ index: String(cursor.index), offset: String(cursor.offset) });
    if (range.version !== undefined) query.set('version', String(range.version));
    const page = AgendaConversationPageSchema.parse(
      await fetchAgenda(daemon, scope, `${base}?${query.toString()}`, { method: 'GET' }, fetcher),
    );
    reads += 1;
    if (page.entry !== undefined) {
      const at = page.index - from;
      const earlier = entries[at];
      entries[at] = earlier === undefined ? page.entry : { ...earlier, text: earlier.text + page.entry.text };
    }
    cursor = page.next;
  }
  const capped = cursor !== undefined && cursor.index < until;
  return { entries: capped ? entries.slice(0, (cursor?.index ?? from) - from) : entries, capped };
};

/** Tells the daemon this device opened `version` of an item; answers the mark that stands. */
export const markAgendaVersionSeen = async (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  id: AgendaId,
  version: number,
  fetcher: DaemonFetch = browserFetch,
): Promise<number> =>
  AgendaSeenResponseSchema.parse(
    await fetchAgenda(
      daemon,
      scope,
      `/v1/ferrets/${encodeURIComponent(scope.sessionId)}/agenda/${encodeURIComponent(id)}/seen`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version }),
      },
      fetcher,
    ),
  ).seen;

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

interface MachineAgendaRead {
  connection: DaemonConnection;
  readonly read: ListRefresh<void>;
}

/**
 * Daemon-scoped attention coordinator. It keeps request coalescing out of the
 * immutable store and fences every continuation by the concrete paired
 * connection: a same-id re-pair or unpair cannot publish stale daemon data.
 */
export class DaemonAgendaClient {
  readonly #machineReads = new Map<DaemonId, MachineAgendaRead>();
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
  /** Every conversation's open and parked items per machine: what the Inbox lists parked items from. */
  readonly rollup: AgendaRollupStore;

  constructor(
    readonly store: DaemonAgendaStore = new DaemonAgendaStore(),
    private readonly fetcher: DaemonFetch = browserFetch,
    private readonly refreshEnvironment: ListRefreshEnvironment = browserListRefreshEnvironment,
  ) {
    this.rollup = new AgendaRollupStore(fetcher);
  }

  hydrate(daemon: DaemonConnection, scope: DaemonSessionScope): Promise<void> {
    assertScopeDaemon(daemon, scope);
    if (isMachineAgendaId(scope.sessionId)) {
      const read = this.#machineRead(daemon, scope);
      if (this.store.status(scope) === 'ready') return Promise.resolve();
      return read.request();
    }
    return this.#load(daemon, scope, false);
  }

  /** Refreshes a complete board even when this session is already hydrated. */
  revalidate(daemon: DaemonConnection, scope: DaemonSessionScope): Promise<void> {
    if (isMachineAgendaId(scope.sessionId)) return this.#machineRead(daemon, scope).request();
    return this.#load(daemon, scope, true);
  }

  #machineRead(daemon: DaemonConnection, scope: DaemonSessionScope): ListRefresh<void> {
    assertScopeDaemon(daemon, scope);
    this.#bind(daemon);
    const existing = this.#machineReads.get(daemon.daemonId);
    if (existing !== undefined) {
      existing.connection = daemon;
      return existing.read;
    }
    const entry: MachineAgendaRead = {
      connection: daemon,
      read: new ListRefresh(() => this.#load(entry.connection, scope, true), this.refreshEnvironment),
    };
    this.#machineReads.set(daemon.daemonId, entry);
    return entry.read;
  }

  /** The fleet stream also carries agenda changes, including the machine's own ledger. */
  noteEvent(daemon: DaemonConnection, event: FyEvent): void {
    if (event.type !== 'agenda.changed' && event.type !== 'attention.changed') return;
    const scope = { daemonId: daemon.daemonId, sessionId: event.sessionId };
    if (isMachineAgendaId(event.sessionId)) {
      void this.#machineRead(daemon, scope)
        .invalidate()
        .catch(() => undefined);
    } else if (this.store.status(scope) === 'ready') {
      void this.revalidate(daemon, scope).catch(() => undefined);
    }
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
    const promise = this.#readLimit(daemon.daemonId)
      .run(async () =>
        this.#currentConnection(daemon, generation) ? await fetchAgendaSnapshot(daemon, scope, this.fetcher) : null,
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
    // The count route is the same complete machine ledger: it must join the full read.
    if (isMachineAgendaId(scope.sessionId)) return this.hydrate(daemon, scope);
    const generation = this.#bind(daemon);
    const key = daemonSessionKey(scope);
    if (this.store.count(scope) !== undefined) return Promise.resolve();
    const existing = this.#countInFlight.get(key);
    if (existing?.generation === generation) return existing.promise;

    const revision = this.#boardRevisions.get(key) ?? 0;
    const promise = fetchAgendaCount(daemon, scope, this.fetcher)
      .then(count => {
        if (this.#current(daemon, generation, key, revision)) this.store.applyCount(scope, count);
      })
      .finally(() => {
        if (this.#countInFlight.get(key)?.promise === promise) this.#countInFlight.delete(key);
      });
    this.#countInFlight.set(key, { generation, promise });
    return promise;
  }

  resolve(
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    id: string,
    note?: string,
    askVersion?: number,
  ): Promise<void> {
    return this.#mutate(daemon, scope, {
      action: 'resolve',
      id,
      ...(note === undefined ? {} : { note }),
      ...(askVersion === undefined ? {} : { askVersion }),
    });
  }

  respond(
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    id: string,
    response: AgendaResponse,
    note?: string,
    gate?: true,
    attachments?: BoardReopenAttachments,
    askVersion?: number,
    cardAsk?: string,
  ): Promise<void> {
    return this.#mutate(daemon, scope, {
      action: 'resolve',
      id,
      response,
      ...(note === undefined ? {} : { note }),
      ...(gate === undefined ? {} : { gate }),
      ...(cardAsk !== undefined && gate !== undefined ? { cardAsk } : {}),
      ...(attachments === undefined ? {} : { attachments }),
      ...(askVersion === undefined ? {} : { askVersion }),
    });
  }

  dismiss(
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    id: string,
    note?: string,
    askVersion?: number,
  ): Promise<void> {
    return this.#mutate(daemon, scope, {
      action: 'dismiss',
      id,
      ...(note === undefined ? {} : { note }),
      ...(askVersion === undefined ? {} : { askVersion }),
    });
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

  /**
   * Merges `from` into `id`: both conversations and every card are kept, `id` survives and
   * `from` closes as "merged into !id".
   */
  merge(daemon: DaemonConnection, scope: DaemonSessionScope, id: string, from: string): Promise<void> {
    return this.#mutate(daemon, scope, { action: 'merge', id, from });
  }

  /** Unpair one daemon without perturbing any other daemon's cache or work. */
  clearDaemon(daemonId: DaemonId): void {
    this.#machineReads.get(daemonId)?.read.stop();
    this.#machineReads.delete(daemonId);
    this.#generations.set(daemonId, (this.#generations.get(daemonId) ?? 0) + 1);
    this.#bindings.delete(daemonId);
    this.store.clearDaemon(daemonId);
    this.rollup.clearDaemon(daemonId);
    this.#clearInFlight(this.#fullInFlight, daemonId);
    this.#clearInFlight(this.#countInFlight, daemonId);
    this.#clearInFlight(this.#mutationTails, daemonId);
    this.#clearBoardRevisions(daemonId);
  }

  /** Delivers the answers the daemon is holding for this ferret now. */
  sendReplies(daemon: DaemonConnection, scope: DaemonSessionScope): Promise<void> {
    return this.#mutate(daemon, scope, () => sendAgendaReplies(daemon, scope, this.fetcher));
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
    const promise = (typeof action === 'function' ? action() : applyAgendaAction(daemon, scope, action, this.fetcher))
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
