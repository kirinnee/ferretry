/**
 * THE FLEET CACHE, ONE SLICE PER PAIRED DAEMON.
 *
 * Ported from kteam `ui/src/lib/store.tsx:307-556` — the hydration, snapshot
 * and mutation half of `FleetStore`. This is the FIRST slice of that port and
 * deliberately stops there: no event socket, no replay buffers, no sequence
 * cursors, no debounced refresh, no reconcile interval, no usage poll, no
 * transcript search. The daemon now mounts `/v1/events`, but browser ticket
 * issuance and this store's event reconciliation remain separate work; those
 * layers do not belong as stubs inside the snapshot cache.
 *
 * WHAT CHANGED FOR FERRETRY — survey rows 35-37, and the reason this file is
 * not a transliteration.
 *
 * kteam had exactly one daemon, so `FleetStore` was a module singleton holding
 * `sessions`, `byId`, `lastSequence`, buffers, subscribers and every inflight
 * map keyed by SESSION ID ALONE (`store.tsx:132-140,311-359`). Session IDs are
 * minted per daemon and collide freely across two of them: a reader paired to
 * a laptop and a workstation can hold two unrelated sessions that answer to the
 * same id. Under the old key shape the second daemon's row overwrites the
 * first's, and a targeted read for one is served the other's answer.
 *
 * So every map here is keyed by `DaemonId` (whole-fleet state) or by
 * `daemonSessionKey` (per-session state), and there is NO daemon-free read:
 * `session(scope)` takes the pair, and no overload takes a bare id. That is the
 * point of the type — a caller that has only a session id cannot reach this
 * cache at all, which is the failure we want, at compile time.
 *
 * GENERATIONS, AND WHY A `DaemonId` IS NOT ENOUGH ON ITS OWN.
 *
 * A `DaemonId` is the DURABLE pairing fingerprint, so the same id survives an
 * unpair/re-pair and a rotated device token. That makes it the right cache key
 * and the WRONG liveness token: a list request issued under the old connection
 * can still be in flight when the reader unpairs, or re-pairs at a new base URL
 * after a network move. Publishing that answer would repopulate a cache the
 * reader just emptied, or serve rows read with a credential that has since been
 * replaced.
 *
 * Each connection therefore gets a private entry carrying its own generation,
 * base URL and token. `clearDaemon` drops the entry; a connection whose base
 * URL or token differs from the recorded one is treated as a RE-PAIR and also
 * drops it. An in-flight request checks that its entry is still the current one
 * before touching shared state. It still ANSWERS ITS OWN CALLER with whatever
 * its own request returned — that promise has a legitimate owner — but it
 * publishes nothing and can never be handed to a fresh query, because the fresh
 * query is coalescing against a different entry. This is the same generation
 * discipline `browser-login.ts` uses for its polls, applied to the fleet read.
 *
 * A re-pair also RESETS the slice rather than keeping it. The device token is
 * the authorization behind every row in the list; once it is replaced, serving
 * the old rows as current state is a claim the new connection never made. An
 * empty slice reads as "loading", which is honest; stale rows do not.
 *
 * WHAT IS KEPT FROM KTEAM, DELIBERATELY:
 *
 *   - IDENTITY REUSE ON A WHOLE-LIST RECONCILE (`store.tsx:509-518`). A list
 *     read replaces every element, so without a structural compare each read
 *     re-renders every open page. An unchanged session keeps its previous
 *     object so `session(scope)` stays referentially stable.
 *   - A FAILED REFRESH NEVER BLANKS A GOOD LIST (`store.tsx:623-635`). The rows
 *     stay, the status becomes `error`, and the reader is told the refresh
 *     failed rather than shown an empty fleet that reads as "nothing running".
 *   - COALESCED READS. A burst of callers for one daemon makes one list
 *     request, and a burst for one session makes one get — but only within the
 *     SAME daemon and the SAME `daemonSessionKey`. Two daemons never share
 *     work, however identical their session ids look.
 *
 * WHAT IS NOT HERE, ON PURPOSE:
 *
 *   - Ghost-row eviction. kteam removed a session when its get returned 404
 *     (`store.tsx:581-585`). Classifying that needs the transport's status
 *     code, and this module takes an injected port with no error vocabulary, so
 *     it belongs with the slice that owns `DaemonResponseError`.
 *   - `projects` and the transcript search snapshot. Projects hydrate through
 *     their dedicated daemon-scoped store; transcript search has no daemon
 *     endpoint. Keeping project reads separate prevents a registry failure from
 *     marking the session fleet itself errored.
 */

import type { SessionState, SessionView } from '@ferretry/protocol';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey } from './daemon-scope.ts';
import { type DeadlineSchedule, MachineDeadlineError, realSchedule, withDeadline } from './machine-deadline.ts';

/** Whether one daemon's session list has been read, and how that read ended. */
export type FleetLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * One paired daemon's fleet, as a screen renders it.
 *
 * `sessions` is `null` until the first read settles, which is a different fact
 * from an empty array: the first means "not read yet" and renders a skeleton,
 * the second means "this daemon runs nothing" and renders an empty state.
 */
export interface DaemonFleetSlice {
  readonly sessions: readonly SessionView[] | null;
  readonly byId: ReadonlyMap<string, SessionView>;
  readonly status: FleetLoadStatus;
  /** The last failed answer. It survives into the next `loading` because a
   *  pending retry does not make the previous failure untrue. */
  readonly error: string | null;
  /**
   * When the last good list read settled, by the store's clock: how a machine that stopped answering
   * says "last seen 5m". Absent until a read has succeeded; a failed read never moves it.
   */
  readonly readAt?: number;
  /**
   * Set while the rows on screen are THIS DEVICE'S CACHED COPY (`session-cache.ts`) and no live read
   * has confirmed them yet: when that copy was saved. A screen says "Updating…" while it is set; the
   * first good live read clears it.
   */
  readonly cachedAt?: number;
}

/** Every paired daemon's fleet, addressed only by `DaemonId`. */
export interface FleetSnapshot {
  readonly daemons: ReadonlyMap<DaemonId, DaemonFleetSlice>;
}

/**
 * A narrow patch over one session's daemon-reported state. It is `SessionState`
 * and nothing wider, so a caller cannot fold an arbitrary bag of fields into a
 * protocol-validated view.
 */
export type SessionStatePatch = Readonly<Partial<SessionState>>;

/**
 * The daemon reads this store needs, injected rather than imported. Each call
 * receives the whole connection, so the port — not the store — decides how a
 * request is addressed and authorized, and a test can drive both reads with
 * controllable promises and no network.
 */
export interface DaemonFleetPort {
  list(daemon: DaemonConnection): Promise<readonly SessionView[]>;
  get(daemon: DaemonConnection, sessionId: string): Promise<SessionView>;
}

const IDLE_SLICE: DaemonFleetSlice = Object.freeze({
  sessions: null,
  byId: new Map<string, SessionView>(),
  status: 'idle' as const,
  error: null,
});

/**
 * One live connection to one daemon. The object identity IS the generation
 * token: an in-flight read compares the entry it started under against the
 * entry the store currently holds.
 */
interface DaemonEntry {
  readonly daemonId: DaemonId;
  readonly baseUrl: string;
  readonly deviceId: string;
  listInflight: Promise<readonly SessionView[]> | null;
  readonly sessionInflight: Map<string, Promise<SessionView>>;
  /** How many list reads this connection has started, and the newest one whose answer was published. */
  listStarted: number;
  listCommitted: number;
}

/**
 * How long one machine's list read may stay unanswered before the store stops waiting for it.
 *
 * A machine that never answers — asleep behind a relay that holds the socket open, a daemon wedged
 * mid-request — used to pin its `listInflight` forever: every later poll coalesced onto the same dead
 * promise, so the machine could never be read again, and its slice said "loading" for good. The read is
 * abandoned instead: the slice says the machine did not answer, the coalescing slot is released so the
 * next poll asks again, and a late answer is still published if nothing newer has been.
 */
export const FLEET_LIST_TIMEOUT_MS = 15_000;

export interface DaemonFleetStoreOptions {
  readonly listTimeoutMs?: number;
  /** The timer, injected so no suite waits on a real clock. */
  readonly schedule?: DeadlineSchedule;
}

/**
 * Structural compare, used ONLY on the whole-list reconcile path. The port
 * yields protocol-validated views, which are acyclic JSON by construction — but
 * `upsertSession` also accepts a caller-supplied view, so a value that cannot
 * be serialized must degrade to "changed" rather than throwing out of a read.
 */
const sameView = (a: SessionView, b: SessionView): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

const indexById = (sessions: readonly SessionView[]): ReadonlyMap<string, SessionView> => {
  const byId = new Map<string, SessionView>();
  for (const view of sessions) byId.set(view.config.id, view);
  return byId;
};

/** A new session goes to the front; a known one is replaced in place. */
const replaceOrPrepend = (sessions: readonly SessionView[], view: SessionView): readonly SessionView[] => {
  const index = sessions.findIndex(candidate => candidate.config.id === view.config.id);
  if (index === -1) return [view, ...sessions];
  const next = sessions.slice();
  next[index] = view;
  return next;
};

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const requireScopeDaemon = (daemon: DaemonConnection, scope: DaemonSessionScope): void => {
  if (daemon.daemonId !== scope.daemonId) throw new Error('session scope must belong to the requested daemon');
};

/**
 * The session cache for every paired daemon, exposed through the external-store
 * contract (`subscribe` / `getSnapshot`) so React reads are synchronous and
 * snapshots are immutable. Slices are always REPLACED, never mutated in place.
 */
export class DaemonFleetStore {
  readonly #port: DaemonFleetPort;
  readonly #listeners = new Set<() => void>();
  readonly #entries = new Map<DaemonId, DaemonEntry>();
  readonly #now: () => number;
  readonly #listTimeoutMs: number;
  readonly #schedule: DeadlineSchedule;
  #snapshot: FleetSnapshot = { daemons: new Map() };

  /** `now` stamps each good read's `readAt`; the real clock unless a suite fixes one. */
  constructor(port: DaemonFleetPort, now: () => number = Date.now, options: DaemonFleetStoreOptions = {}) {
    this.#port = port;
    this.#now = now;
    this.#listTimeoutMs = options.listTimeoutMs ?? FLEET_LIST_TIMEOUT_MS;
    this.#schedule = options.schedule ?? realSchedule;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getSnapshot(): FleetSnapshot {
    return this.#snapshot;
  }

  /** One daemon's fleet. An unknown daemon reads as unread, never as empty. */
  fleet(daemonId: DaemonId): DaemonFleetSlice {
    return this.#snapshot.daemons.get(daemonId) ?? IDLE_SLICE;
  }

  /**
   * One session on one daemon. There is deliberately no overload taking a bare
   * session id: two daemons can both own that id, and picking either would be
   * a coin flip the caller could not see.
   */
  session(scope: DaemonSessionScope): SessionView | undefined {
    return this.fleet(scope.daemonId).byId.get(scope.sessionId);
  }

  /**
   * Reads one daemon's whole session list. Concurrent callers for the SAME
   * connection share the one request; a different daemon, or the same daemon
   * after a clear or a re-pair, starts its own.
   */
  hydrate(daemon: DaemonConnection): Promise<readonly SessionView[]> {
    const entry = this.#entryFor(daemon);
    const existing = entry.listInflight;
    if (existing !== null) return existing;

    this.#patchSlice(entry.daemonId, { status: 'loading' });
    entry.listStarted += 1;
    const sequence = entry.listStarted;
    // Only the newest read may publish, so a late answer never replaces a fresher one.
    const publishes = (): boolean => this.#isCurrent(entry) && sequence > entry.listCommitted;
    const read = this.#port.list(daemon).then(
      list => {
        if (publishes()) {
          entry.listCommitted = sequence;
          this.#commitList(entry.daemonId, list);
        }
        return list;
      },
      (cause: unknown) => {
        // The rows that were already correct stay. Only the status and the
        // message change, so a transient failure cannot read as an empty fleet.
        if (publishes()) this.#patchSlice(entry.daemonId, { status: 'error', error: messageOf(cause) });
        throw cause;
      },
    );
    // The read is not cancelled — the port owns its transport — so a late answer can still publish.
    const request = withDeadline(read, this.#listTimeoutMs, this.#schedule)
      .catch((cause: unknown) => {
        if (cause instanceof MachineDeadlineError && publishes())
          this.#patchSlice(entry.daemonId, { status: 'error', error: `the machine ${cause.message}` });
        throw cause;
      })
      .finally(() => {
        if (entry.listInflight === request) entry.listInflight = null;
      });

    entry.listInflight = request;
    return request;
  }

  /**
   * Draws a machine's list from this device's cached copy before the live read answers. Only an
   * UNREAD slice is seeded: rows a live read already produced are never replaced by older ones, and a
   * live answer that lands later replaces these. The connection's entry is taken exactly as a read
   * would take it, so a clear or a re-pair drops the seeded rows like any others.
   */
  seed(daemon: DaemonConnection, sessions: readonly SessionView[], savedAt: number): boolean {
    const entry = this.#entryFor(daemon);
    if (this.fleet(entry.daemonId).sessions !== null) return false;
    this.#patchSlice(entry.daemonId, { sessions, byId: indexById(sessions), readAt: savedAt, cachedAt: savedAt });
    return true;
  }

  /**
   * Reads ONE session. Coalescing is keyed by the full `daemonSessionKey`, so
   * the same session id on two paired daemons is two independent requests.
   */
  fetchSession(daemon: DaemonConnection, scope: DaemonSessionScope): Promise<SessionView> {
    requireScopeDaemon(daemon, scope);
    const entry = this.#entryFor(daemon);
    const key = daemonSessionKey(scope);
    const existing = entry.sessionInflight.get(key);
    if (existing !== undefined) return existing;

    const request = this.#port
      .get(daemon, scope.sessionId)
      .then(view => {
        // The daemon's answer is untrusted: folding a different session in
        // under this scope would silently corrupt the row the caller asked for.
        if (view.config.id !== scope.sessionId) throw new Error('daemon returned another session');
        if (this.#isCurrent(entry)) this.#upsert(entry.daemonId, view);
        return view;
      })
      .finally(() => {
        entry.sessionInflight.delete(key);
      });

    entry.sessionInflight.set(key, request);
    return request;
  }

  /**
   * Folds one session in, for a caller that already has an authoritative view.
   * A daemon this store holds no connection for is ignored: a slice created
   * without an entry could never be invalidated by a clear or a re-pair, so it
   * would outlive the pairing that justified it.
   */
  upsertSession(daemonId: DaemonId, view: SessionView): boolean {
    if (!this.#entries.has(daemonId)) return false;
    return this.#upsert(daemonId, view);
  }

  /** Drops one session from one daemon. Every other daemon is untouched. */
  removeSession(scope: DaemonSessionScope): boolean {
    const current = this.fleet(scope.daemonId);
    if (current.sessions === null) return false;
    const sessions = current.sessions.filter(view => view.config.id !== scope.sessionId);
    if (sessions.length === current.sessions.length) return false;
    this.#patchSlice(scope.daemonId, { sessions, byId: indexById(sessions) });
    return true;
  }

  /**
   * Applies a narrow state delta to one session. A patch that changes nothing
   * writes nothing and notifies nobody — the later event slice applies a patch
   * per frame, and a fleet re-render for an identical activity line is exactly
   * the churn this store exists to avoid.
   */
  patchSessionState(scope: DaemonSessionScope, patch: SessionStatePatch): boolean {
    const view = this.session(scope);
    if (view === undefined) return false;
    const keys = Object.keys(patch) as readonly (keyof SessionState)[];
    if (keys.length === 0) return false;
    if (keys.every(key => Object.is(view.state[key], patch[key]))) return false;
    return this.#upsert(scope.daemonId, { ...view, state: { ...view.state, ...patch } });
  }

  /**
   * Forgets one daemon completely: its cached fleet and its connection. Any
   * read still in flight answers its own caller and publishes nothing, and a
   * later pairing to the same `DaemonId` starts from an empty slice.
   */
  clearDaemon(daemonId: DaemonId): boolean {
    return this.#drop(daemonId);
  }

  // -- internals ------------------------------------------------------------

  /**
   * The entry for this exact connection. A connection whose base URL or token
   * differs from the recorded one is a RE-PAIR of the same durable daemon, and
   * gets a fresh entry — which invalidates every read issued under the old one.
   */
  #entryFor(daemon: DaemonConnection): DaemonEntry {
    const existing = this.#entries.get(daemon.daemonId);
    if (existing !== undefined) {
      if (existing.baseUrl === daemon.baseUrl && existing.deviceId === daemon.deviceId) return existing;
      this.#drop(daemon.daemonId);
    }
    const entry: DaemonEntry = {
      daemonId: daemon.daemonId,
      baseUrl: daemon.baseUrl,
      deviceId: daemon.deviceId,
      listInflight: null,
      sessionInflight: new Map(),
      listStarted: 0,
      listCommitted: 0,
    };
    this.#entries.set(daemon.daemonId, entry);
    return entry;
  }

  #isCurrent(entry: DaemonEntry): boolean {
    return this.#entries.get(entry.daemonId) === entry;
  }

  #drop(daemonId: DaemonId): boolean {
    const hadEntry = this.#entries.delete(daemonId);
    if (this.#snapshot.daemons.has(daemonId)) {
      const daemons = new Map(this.#snapshot.daemons);
      daemons.delete(daemonId);
      this.#publish({ daemons });
      return true;
    }
    return hadEntry;
  }

  #commitList(daemonId: DaemonId, list: readonly SessionView[]): void {
    const previous = this.fleet(daemonId);
    const sessions = list.map(view => {
      const old = previous.byId.get(view.config.id);
      return old !== undefined && sameView(old, view) ? old : view;
    });
    this.#patchSlice(daemonId, {
      sessions,
      byId: indexById(sessions),
      status: 'ready',
      error: null,
      readAt: this.#now(),
      cachedAt: undefined,
    });
  }

  #upsert(daemonId: DaemonId, view: SessionView): boolean {
    const current = this.fleet(daemonId);
    if (current.byId.get(view.config.id) === view) return false;
    const sessions = current.sessions === null ? [view] : replaceOrPrepend(current.sessions, view);
    this.#patchSlice(daemonId, { sessions, byId: indexById(sessions) });
    return true;
  }

  #patchSlice(daemonId: DaemonId, patch: Partial<DaemonFleetSlice>): void {
    const daemons = new Map(this.#snapshot.daemons).set(daemonId, { ...this.fleet(daemonId), ...patch });
    this.#publish({ daemons });
  }

  #publish(snapshot: FleetSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
