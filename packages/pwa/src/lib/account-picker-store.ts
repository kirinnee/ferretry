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
 * Automatic hydration reads only the manifest. Quota comes from the existing
 * cached usage store, and health is checked only after a deliberate action.
 * A failed read never replaces a previously proved catalog with a fabricated
 * empty one; the slice keeps its last answer and reports the failure.
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
  health(daemon: DaemonConnection): Promise<AccountPickerHealthCatalog>;
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
   * Refresh one daemon's roster. A burst for the same authority shares one
   * request; another daemon or a re-paired connection never does.
   */
  hydrate(daemon: DaemonConnection): Promise<AccountPickerCatalog> {
    const entry = this.#entryFor(daemon);
    if (entry.catalogRequest !== null) return entry.catalogRequest;
    const slice = this.sliceFor(daemon);
    if (slice.catalog !== null) return Promise.resolve(slice.catalog);
    if (entry.catalogAttempted) {
      return Promise.reject(new Error(slice.error ?? 'the account roster could not be read'));
    }

    return this.#readCatalog(entry);
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

  /** Run the live wrapper check only after an explicit reader action. */
  checkHealth(daemon: DaemonConnection): Promise<AccountPickerHealthCatalog> {
    const entry = this.#entryFor(daemon);
    if (entry.healthRequest !== null) return entry.healthRequest;

    this.#patch(entry, { healthStatus: 'loading', healthError: null });
    const request = this.#port
      .health(entry.connection)
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
