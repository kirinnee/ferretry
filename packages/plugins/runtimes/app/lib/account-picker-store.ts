/**
 * THE PICKABLE RUNTIME ROSTER OF ONE DAEMON.
 *
 * A client is per daemon (§9.6) and the shell builds an app half once per daemon, so a store made over that
 * client already belongs to exactly one machine: there is nothing to key by daemon and no connection to fence. A
 * re-pair replaces the client, and with it the half and this store.
 *
 * AUTOMATIC HYDRATION READS HEALTH BESIDE THE RUNTIMES: each login's status word from `GET /v1/logins`, a store read
 * the daemon answers without calling any provider, so hydrating it is one local call. The deliberate action survives
 * as {@link AccountPickerStore.checkHealth}, which asks the host to check each login NOW.
 *
 * A failed read never replaces a previously proved catalog with a fabricated empty one; the slice keeps its last
 * answer and reports the failure.
 */

import type {
  AccountPickerCatalog,
  AccountPickerHealthCatalog,
  PickerAccountHealth,
} from './account-picker-catalog.ts';

type AccountPickerLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface AccountPickerSlice {
  readonly catalog: AccountPickerCatalog | null;
  readonly status: AccountPickerLoadStatus;
  readonly error: string | null;
  readonly health: ReadonlyMap<string, PickerAccountHealth> | null;
  readonly healthStatus: AccountPickerLoadStatus;
  readonly healthError: string | null;
}

export interface AccountPickerPort {
  catalog(): Promise<AccountPickerCatalog>;
  /** The stored verdicts. A snapshot read; the daemon checks nothing to answer it. */
  health(): Promise<AccountPickerHealthCatalog>;
  /**
   * Collect the free evidence now, then answer with the snapshot.
   *
   * A SECOND METHOD RATHER THAN A FLAG, because the two are different HTTP verbs on different paths and only one of
   * them records anything. A boolean parameter would put "does this write" behind a call-site argument, which is
   * exactly the shape that let a read reach a spending probe before.
   */
  checkHealth(): Promise<AccountPickerHealthCatalog>;
}

const IDLE_SLICE: AccountPickerSlice = Object.freeze({
  catalog: null,
  status: 'idle' as const,
  error: null,
  health: null,
  healthStatus: 'idle' as const,
  healthError: null,
});

const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

export class AccountPickerStore {
  readonly #port: AccountPickerPort;
  readonly #listeners = new Set<() => void>();
  #snapshot: AccountPickerSlice = IDLE_SLICE;
  #catalogAttempted = false;
  #catalogRequest: Promise<AccountPickerCatalog> | null = null;
  /**
   * Whether health has been read once, so a re-render cannot re-fetch it. The same latch `#catalogAttempted` is, for
   * the same reason: an automatic read must happen once per store, not once per mount.
   */
  #healthAttempted = false;
  #healthRequest: Promise<AccountPickerHealthCatalog> | null = null;

  constructor(port: AccountPickerPort) {
    this.#port = port;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): AccountPickerSlice => this.#snapshot;

  /**
   * Read the roster, and the stored health beside it.
   *
   * A burst shares one request.
   *
   * HEALTH IS FETCHED HERE AND ITS FAILURE IS NEVER THE ROSTER'S. The roster is what a picker cannot function
   * without; health is evidence about the rows. A daemon that serves runtimes and cannot serve verdicts must still
   * fill the text box, so the health read is fired alongside and its rejection is swallowed into the slice's own
   * `healthError`. Awaiting it would make an unrelated failure look like an empty fleet.
   */
  hydrate(): Promise<AccountPickerCatalog> {
    // Before the roster's early returns, and deliberately: this has its own latch, so it fires once however many
    // times a re-render calls `hydrate`. Putting it after them would mean a daemon whose FIRST roster read failed
    // never hydrated health at all, even though the two reads are independent.
    this.#hydrateHealth();
    if (this.#catalogRequest !== null) return this.#catalogRequest;
    if (this.#snapshot.catalog !== null) return Promise.resolve(this.#snapshot.catalog);
    if (this.#catalogAttempted) {
      return Promise.reject(new Error(this.#snapshot.error ?? 'the runtime roster could not be read'));
    }
    return this.#readCatalog();
  }

  /** Read the stored verdicts once, on the same trigger as the roster. A reader who wants a fresher answer presses "Check now". */
  #hydrateHealth(): void {
    if (this.#healthAttempted || this.#healthRequest !== null) return;
    this.#healthAttempted = true;
    void this.#readHealth(() => this.#port.health()).catch(() => undefined);
  }

  /** Deliberately retry the cheap roster read while retaining last-good rows. */
  refresh(): Promise<AccountPickerCatalog> {
    return this.#catalogRequest ?? this.#readCatalog();
  }

  /**
   * Read the roster and the stored verdicts again, keeping the rows on screen until the answers land: the machine
   * said its runtimes or logins moved. A read already in flight is joined, not repeated.
   */
  reread(): void {
    if (this.#catalogRequest === null) void this.#readCatalog().catch(() => undefined);
    if (this.#healthRequest === null) {
      this.#healthAttempted = true;
      void this.#readHealth(() => this.#port.health()).catch(() => undefined);
    }
  }

  #readCatalog(): Promise<AccountPickerCatalog> {
    this.#catalogAttempted = true;
    this.#patch({ status: 'loading', error: null });
    const request = this.#port
      .catalog()
      .then(
        catalog => {
          this.#patch({ catalog, status: 'ready', error: null });
          return catalog;
        },
        (reason: unknown) => {
          this.#patch({ status: 'error', error: failureMessage(reason) });
          throw reason;
        },
      )
      .finally(() => {
        if (this.#catalogRequest === request) this.#catalogRequest = null;
      });
    this.#catalogRequest = request;
    return request;
  }

  /**
   * Collect the free evidence now, on an explicit reader action.
   *
   * Shares the in-flight slot with the automatic read, so pressing the button while the mount's hydration is still
   * running joins that request instead of starting a second one — and a burst of presses is one collection.
   */
  checkHealth(): Promise<AccountPickerHealthCatalog> {
    if (this.#healthRequest !== null) return this.#healthRequest;
    this.#healthAttempted = true;
    return this.#readHealth(() => this.#port.checkHealth());
  }

  #readHealth(read: () => Promise<AccountPickerHealthCatalog>): Promise<AccountPickerHealthCatalog> {
    this.#patch({ healthStatus: 'loading', healthError: null });
    const request = read()
      .then(
        result => {
          this.#patch({
            health: result.health,
            healthStatus: result.error === null ? 'ready' : 'error',
            healthError: result.error,
          });
          return result;
        },
        (reason: unknown) => {
          this.#patch({ healthStatus: 'error', healthError: failureMessage(reason) });
          throw reason;
        },
      )
      .finally(() => {
        this.#healthRequest = null;
      });
    this.#healthRequest = request;
    return request;
  }

  #patch(patch: Partial<AccountPickerSlice>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
