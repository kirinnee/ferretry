/**
 * THE PICKABLE ACCOUNT ROSTER, ONE SLICE PER PAIRED DAEMON.
 *
 * Account wrappers and explicit health checks belong to the host that reported
 * them. A wrapper name is not globally meaningful, so this store has no
 * daemon-free read and fences every in-flight request across unpair/re-pair.
 *
 * WHAT IS CACHED IS EVIDENCE, NOT A TRANSPORT. The cache authority is the daemon
 * and the credential that proved the rows; the carrier the bytes travelled on is
 * not part of it, so republishing the carrier set — a relay added, reordered or
 * withdrawn — keeps the slice whole.
 *
 * AUTOMATIC HYDRATION NOW READS HEALTH BESIDE THE MANIFEST. It did not, and could
 * not: health used to mean starting every account's agent and asking a model to
 * answer a sentinel, so reading it on mount would have spent real money on a host
 * nobody was sitting at. It is now a stored verdict the daemon derived from the
 * free read-only usage GET it already makes, so `GET /v1/fleet/health` is a
 * snapshot read and hydrating it is one local HTTP call.
 *
 * The deliberate action survives as {@link DaemonAccountPickerStore.checkHealth},
 * which asks the host to collect that free evidence NOW. It still spends nothing.
 *
 * Quota comes from the existing cached usage store. A failed read never replaces
 * a previously proved catalog with a fabricated empty one; the slice keeps its
 * last answer and reports the failure.
 */

import type {
  AccountPickerCatalog,
  AccountPickerHealthCatalog,
  PickerAccountHealth,
} from './account-picker-catalog.ts';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';

export type AccountPickerLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface DaemonAccountPickerSlice {
  /** Opaque connection generation; never derived from a credential. */
  readonly generation: number;
  readonly catalog: AccountPickerCatalog | null;
  readonly status: AccountPickerLoadStatus;
  readonly error: string | null;
  readonly health: ReadonlyMap<string, PickerAccountHealth> | null;
  readonly healthStatus: AccountPickerLoadStatus;
  readonly healthError: string | null;
}

export interface AccountPickerSnapshot {
  readonly daemons: ReadonlyMap<DaemonId, DaemonAccountPickerSlice>;
}

export interface DaemonAccountPickerPort {
  catalog(daemon: DaemonConnection): Promise<AccountPickerCatalog>;
  /** The stored verdicts. A snapshot read; the daemon checks nothing to answer it. */
  health(daemon: DaemonConnection): Promise<AccountPickerHealthCatalog>;
  /**
   * Collect the free evidence now, then answer with the snapshot.
   *
   * A SECOND METHOD RATHER THAN A FLAG, because the two are different HTTP verbs on
   * different paths and only one of them records anything. A boolean parameter
   * would put "does this write" behind a call-site argument, which is exactly the
   * shape that let a read reach a spending probe before.
   */
  checkHealth(daemon: DaemonConnection): Promise<AccountPickerHealthCatalog>;
}

const IDLE_SLICE: DaemonAccountPickerSlice = Object.freeze({
  generation: 0,
  catalog: null,
  status: 'idle' as const,
  error: null,
  health: null,
  healthStatus: 'idle' as const,
  healthError: null,
});

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/**
 * Does this connection speak for the same already-settled evidence?
 *
 * DELIBERATELY NOT `sameDaemonConnection`. That predicate answers a different
 * question — is this the same LIVE carrier — and it must keep answering it for
 * anything holding an open socket or an in-flight byte. What this store holds is
 * neither: it is authenticated evidence a daemon already proved, keyed by WHO
 * proved it. A daemon republishing its carrier set is a carrier-only change —
 * `DaemonConnectionStore.replaceCarriers` preserves its caches for exactly this
 * reason — and routing bytes down a different path does not unprove a roster or
 * expire a health result the reader explicitly paid for.
 *
 * THE CREDENTIAL AND DAEMON FENCE IS UNCHANGED. A rotated `deviceToken` or a
 * moved `baseUrl` IS a re-pair: it mints a new generation, drops the caches, and
 * fences every late read. Only `carriers` is excluded, and only because it is a
 * set of addresses rather than an authority.
 */
const sameAccountPickerAuthority = (left: DaemonConnection, right: DaemonConnection): boolean =>
  left.daemonId === right.daemonId && left.baseUrl === right.baseUrl && left.deviceToken === right.deviceToken;

interface AccountPickerEntry {
  readonly daemonId: DaemonId;
  /** The newest carrier for this authority; later reads are issued against it. */
  connection: DaemonConnection;
  readonly generation: number;
  catalogAttempted: boolean;
  catalogRequest: Promise<AccountPickerCatalog> | null;
  /**
   * Whether health has been read once for this authority, so a re-render cannot
   * re-fetch it. The same latch `catalogAttempted` is, for the same reason: an
   * automatic read must happen once per pairing generation, not once per mount.
   */
  healthAttempted: boolean;
  healthRequest: Promise<AccountPickerHealthCatalog> | null;
}

export class DaemonAccountPickerStore {
  readonly #port: DaemonAccountPickerPort;
  readonly #entries = new Map<DaemonId, AccountPickerEntry>();
  readonly #listeners = new Set<() => void>();
  #issuedGeneration = 0;
  #snapshot: AccountPickerSnapshot = { daemons: new Map() };

  constructor(port: DaemonAccountPickerPort) {
    this.#port = port;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): AccountPickerSnapshot => this.#snapshot;

  /** One daemon's slice. An unknown daemon is unread, never empty. */
  slice(daemonId: DaemonId): DaemonAccountPickerSlice {
    return this.#snapshot.daemons.get(daemonId) ?? IDLE_SLICE;
  }

  /** A pure connection-aware read; another pairing's generation is unread. */
  sliceFor(daemon: DaemonConnection): DaemonAccountPickerSlice {
    const entry = this.#entries.get(daemon.daemonId);
    if (entry === undefined || !sameAccountPickerAuthority(entry.connection, daemon)) return IDLE_SLICE;
    const slice = this.slice(daemon.daemonId);
    return slice.generation === entry.generation ? slice : IDLE_SLICE;
  }

  /**
   * Refresh one daemon's roster, and the stored health beside it.
   *
   * A burst for the same authority shares one request; another daemon or a
   * re-paired connection never does.
   *
   * HEALTH IS FETCHED HERE AND ITS FAILURE IS NEVER THE ROSTER'S. The roster is
   * what a picker cannot function without; health is evidence about the rows. A
   * daemon that serves accounts and cannot serve verdicts must still fill the
   * text box, so the health read is fired alongside and its rejection is
   * swallowed into the slice's own `healthError`. Awaiting it would make an
   * unrelated failure look like an empty fleet.
   */
  hydrate(daemon: DaemonConnection): Promise<AccountPickerCatalog> {
    const entry = this.#entryFor(daemon);
    // Before the roster's early returns, and deliberately: this has its own latch, so it fires once
    // per pairing generation however many times a re-render calls `hydrate`. Putting it after them
    // would mean a daemon whose FIRST roster read failed never hydrated health at all, even though
    // the two reads are independent and the verdicts may be perfectly readable.
    this.#hydrateHealth(entry);
    if (entry.catalogRequest !== null) return entry.catalogRequest;
    const slice = this.sliceFor(daemon);
    if (slice.catalog !== null) return Promise.resolve(slice.catalog);
    if (entry.catalogAttempted) {
      return Promise.reject(new Error(slice.error ?? 'the account roster could not be read'));
    }

    return this.#readCatalog(entry);
  }

  /**
   * Read the stored verdicts once per authority, on the same trigger as the roster.
   *
   * Once: a re-render must not re-fetch, and `healthAttempted` is what stops it —
   * the same latch the roster uses, for the same reason. A reader who wants a
   * fresher answer presses "Check now", which is a different call.
   */
  #hydrateHealth(entry: AccountPickerEntry): void {
    if (entry.healthAttempted || entry.healthRequest !== null) return;
    entry.healthAttempted = true;
    void this.#readHealth(entry, connection => this.#port.health(connection)).catch(() => undefined);
  }

  /** Deliberately retry the cheap manifest read while retaining last-good rows. */
  refresh(daemon: DaemonConnection): Promise<AccountPickerCatalog> {
    const entry = this.#entryFor(daemon);
    if (entry.catalogRequest !== null) return entry.catalogRequest;
    return this.#readCatalog(entry);
  }

  #readCatalog(entry: AccountPickerEntry): Promise<AccountPickerCatalog> {
    entry.catalogAttempted = true;

    this.#patch(entry, { status: 'loading', error: null });
    const request = this.#port
      .catalog(entry.connection)
      .then(
        catalog => {
          if (this.#isCurrent(entry)) this.#patch(entry, { catalog, status: 'ready', error: null });
          return catalog;
        },
        (reason: unknown) => {
          if (this.#isCurrent(entry)) this.#patch(entry, { status: 'error', error: failureMessage(reason) });
          throw reason;
        },
      )
      .finally(() => {
        if (entry.catalogRequest === request) entry.catalogRequest = null;
      });
    entry.catalogRequest = request;
    return request;
  }

  /**
   * Collect the free evidence now, on an explicit reader action.
   *
   * Shares the in-flight slot with the automatic read, so pressing the button
   * while the mount's hydration is still running joins that request instead of
   * starting a second one — and a burst of presses is one collection.
   */
  checkHealth(daemon: DaemonConnection): Promise<AccountPickerHealthCatalog> {
    const entry = this.#entryFor(daemon);
    if (entry.healthRequest !== null) return entry.healthRequest;
    entry.healthAttempted = true;
    return this.#readHealth(entry, connection => this.#port.checkHealth(connection));
  }

  #readHealth(
    entry: AccountPickerEntry,
    read: (connection: DaemonConnection) => Promise<AccountPickerHealthCatalog>,
  ): Promise<AccountPickerHealthCatalog> {
    this.#patch(entry, { healthStatus: 'loading', healthError: null });
    const request = read(entry.connection)
      .then(
        result => {
          if (this.#isCurrent(entry)) {
            this.#patch(entry, {
              health: result.health,
              healthStatus: result.error === null ? 'ready' : 'error',
              healthError: result.error,
            });
          }
          return result;
        },
        (reason: unknown) => {
          if (this.#isCurrent(entry)) {
            this.#patch(entry, { healthStatus: 'error', healthError: failureMessage(reason) });
          }
          throw reason;
        },
      )
      .finally(() => {
        entry.healthRequest = null;
      });
    entry.healthRequest = request;
    return request;
  }

  /** Drop one pairing generation without disturbing any other daemon. */
  clearDaemon(daemonId: DaemonId): boolean {
    this.#entries.delete(daemonId);
    const slices = new Map(this.#snapshot.daemons);
    const had = slices.delete(daemonId);
    if (had) {
      this.#snapshot = { daemons: slices };
      this.#publish();
    }
    return had;
  }

  #entryFor(daemon: DaemonConnection): AccountPickerEntry {
    const existing = this.#entries.get(daemon.daemonId);
    if (existing !== undefined && sameAccountPickerAuthority(existing.connection, daemon)) {
      // Adopt the newest carrier without disturbing the generation, the caches,
      // or a request already in flight against the previous one.
      existing.connection = daemon;
      return existing;
    }

    const entry: AccountPickerEntry = {
      daemonId: daemon.daemonId,
      connection: daemon,
      generation: this.#mintGeneration(),
      catalogAttempted: false,
      catalogRequest: null,
      healthAttempted: false,
      healthRequest: null,
    };
    this.#entries.set(daemon.daemonId, entry);
    return entry;
  }

  #isCurrent(entry: AccountPickerEntry): boolean {
    return this.#entries.get(entry.daemonId) === entry;
  }

  #patch(entry: AccountPickerEntry, patch: Partial<DaemonAccountPickerSlice>): void {
    const daemons = new Map(this.#snapshot.daemons);
    const current = this.slice(entry.daemonId);
    const base = current.generation === entry.generation ? current : { ...IDLE_SLICE, generation: entry.generation };
    daemons.set(entry.daemonId, { ...base, ...patch, generation: entry.generation });
    this.#snapshot = { daemons };
    this.#publish();
  }

  #mintGeneration(): number {
    this.#issuedGeneration += 1;
    return this.#issuedGeneration;
  }

  #publish(): void {
    for (const listener of this.#listeners) listener();
  }
}
