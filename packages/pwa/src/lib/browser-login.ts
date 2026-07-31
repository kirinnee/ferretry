/**
 * The daemon-global human browser-login window — a short-lived VNC desktop a
 * person signs into by hand, one per paired daemon.
 *
 * Ported from kteam `ui/src/lib/browser-login.ts`, with the module singleton
 * removed. kteam kept ONE snapshot, timer, generation counter, in-flight slot
 * and listener set for the whole app, because there was only ever one daemon.
 * All of it is daemon-global state, and the snapshot is not a readout but a
 * CREDENTIAL: a live VNC host, port and password. Shared between two paired
 * daemons it shows daemon A's password to a reader looking at daemon B, one
 * `clearPoll()` stops daemon A's polling when daemon B acts, one generation
 * counter lets an action on A invalidate a poll on B, and the single-slot
 * dedupe answers B's read with A's promise. Every one of those is a wrong
 * answer rather than a stale one.
 *
 * So each of those five pieces of state belongs to a `DaemonId` entry here,
 * and no public method can ask for a status without naming its daemon. A
 * connection replaced under the same `DaemonId` (re-pair, rotated token, new
 * origin) is treated the same way: everything the old connection produced is
 * dropped rather than relabelled.
 *
 * Kept from the source, deliberately:
 *
 *   - A failed read or action resolves to `{ state: 'unknown', error }`. Never
 *     a rejection, and never `closed`: a closed-looking failure renders as no
 *     banner at all, which is a login window silently left open.
 *   - Closing is explicit human intent ('I signed in' / 'not signed in'), never
 *     inferred from the state.
 *   - An action POSTs and then immediately GETs. The POST's own status is not
 *     authoritative — teardown and startup continue after it answers.
 *   - The generation fence: a read started before an action must never publish
 *     over that action's result, though it still answers its own caller.
 *   - 2s polling while anything is happening, 30s while closed, and no polling
 *     at all while nobody is listening.
 *
 * Not ported: `resetBrowserLoginStore` and `browserLoginSnapshotForTest`
 * (source 164-176). Both exist only because the state was a module singleton.
 *
 * Two Ferretry facts about transport: there is no ambient token and no page
 * origin to fetch from, so the HTTP seam is a port built from one runtime
 * `DaemonConnection` and the typed protocol client (which owns authentication
 * and the `x-fy-request-id` mutation header); and `/v1/browser/login` is not
 * mounted by any daemon yet, so this module is proved against an injected port
 * rather than end to end.
 *
 * Credentials stay in memory: never storage, never a query string, never this
 * public static bundle.
 */

import {
  BrowserLoginActionSchema,
  BrowserLoginStatusSchema,
  type BrowserLoginAction,
  type BrowserLoginStatus,
  type IFyApiClient,
} from '@ferretry/protocol';
import type { DaemonConnection, DaemonId } from './daemon-connection.ts';

export const BROWSER_LOGIN_PATH = '/v1/browser/login';

/** Something is happening: poll fast enough for a person to watch it happen. */
export const BROWSER_LOGIN_OPEN_POLL_MS = 2_000;

/** Nothing is open: this is a liveness check, not an animation. */
export const BROWSER_LOGIN_CLOSED_POLL_MS = 30_000;

/** A failed read is deliberately not made to look like a closed window. */
export interface BrowserLoginUnknown {
  readonly state: 'unknown';
  readonly error: string;
}

/**
 * What one daemon's login window is doing, or `unknown` when the daemon could
 * not be asked. `null` (see `getSnapshot`) is the third case: not read yet.
 *
 * This is structurally the `BrowserLoginView` the already-ported banner takes,
 * which owns that name; the assignability is asserted by the unit test rather
 * than re-exported, so the barrel keeps one definition of each type.
 */
export type BrowserLoginSnapshot = BrowserLoginStatus | BrowserLoginUnknown;

/**
 * The read/act seam for exactly one paired daemon. It answers with the raw
 * payload: parsing belongs to the store, so no injected port can hand the
 * banner a status the protocol schema never saw.
 */
export interface BrowserLoginPort {
  readonly status: () => Promise<unknown>;
  readonly act: (action: BrowserLoginAction) => Promise<unknown>;
}

/** Supplies the port for a daemon the store has not seen before. */
export type BrowserLoginPortFactory = (daemon: DaemonConnection) => BrowserLoginPort;

/**
 * Builds the port over the typed client already bound to one daemon, so the
 * device token, protocol version and mutation request id stay protocol-owned
 * and this module never constructs a URL or a header of its own.
 */
export const browserLoginPort = (client: IFyApiClient): BrowserLoginPort => ({
  status: () => client.request(BROWSER_LOGIN_PATH, BrowserLoginStatusSchema),
  act: action =>
    client.request(BROWSER_LOGIN_PATH, BrowserLoginStatusSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Explicit intent on the wire, validated by the protocol schema: the
      // daemon is told what the human chose, never asked to infer it.
      body: JSON.stringify(BrowserLoginActionSchema.parse(action)),
    }),
});

/** Cancels the poll it was returned from, and nothing else. */
export type CancelBrowserLoginPoll = () => void;

/**
 * Schedules one daemon's next poll. The canceller is the return value rather
 * than a separate call taking a handle, so no daemon can be handed the token
 * that stops another daemon's timer.
 */
export type ScheduleBrowserLoginPoll = (run: () => void, delayMs: number) => CancelBrowserLoginPoll;

const scheduleWithTimeout: ScheduleBrowserLoginPoll = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

export interface BrowserLoginStoreOptions {
  readonly openPollMs?: number;
  readonly closedPollMs?: number;
  /** Injected so the cadence and the no-listener case are deterministic. */
  readonly schedule?: ScheduleBrowserLoginPoll;
}

interface DaemonLogin {
  connection: DaemonConnection;
  port: BrowserLoginPort;
  readonly listeners: Set<() => void>;
  snapshot: BrowserLoginSnapshot | null;
  cancelPoll: CancelBrowserLoginPoll | null;
  generation: number;
  inFlight: { readonly generation: number; readonly promise: Promise<BrowserLoginSnapshot> } | null;
}

const notify = (login: DaemonLogin): void => {
  for (const listener of login.listeners) listener();
};

const publish = (login: DaemonLogin, snapshot: BrowserLoginSnapshot): void => {
  login.snapshot = snapshot;
  notify(login);
};

const clearPoll = (login: DaemonLogin): void => {
  if (login.cancelPoll !== null) login.cancelPoll();
  login.cancelPoll = null;
};

/**
 * The daemon's answer is untrusted input. The banner renders `error` verbatim
 * to a person, so an unparseable status becomes a sentence rather than a
 * schema dump — the reader's next move is the same either way.
 */
const readStatus = (value: unknown): BrowserLoginStatus => {
  const parsed = BrowserLoginStatusSchema.safeParse(value);
  if (!parsed.success) throw new Error('The daemon returned an unreadable browser-login status.');
  return parsed.data;
};

const unknownFrom = (caught: unknown, fallback: string): BrowserLoginUnknown => ({
  state: 'unknown',
  error: caught instanceof Error ? caught.message : fallback,
});

/**
 * Every paired daemon's login window, keyed by `DaemonId` alone.
 *
 * The window is daemon-global, so there is deliberately no session in the key:
 * inventing a placeholder session id would fake a scope the daemon does not
 * have. The host subscribes, reads, refreshes and acts for the daemon the
 * reader selected, and `clearDaemon` on unpair cancels and invalidates that
 * daemon's entry alone.
 */
export class DaemonBrowserLoginStore {
  readonly #logins = new Map<DaemonId, DaemonLogin>();
  readonly #createPort: BrowserLoginPortFactory;
  readonly #openPollMs: number;
  readonly #closedPollMs: number;
  readonly #schedule: ScheduleBrowserLoginPoll;

  constructor(createPort: BrowserLoginPortFactory, options: BrowserLoginStoreOptions = {}) {
    this.#createPort = createPort;
    this.#openPollMs = options.openPollMs ?? BROWSER_LOGIN_OPEN_POLL_MS;
    this.#closedPollMs = options.closedPollMs ?? BROWSER_LOGIN_CLOSED_POLL_MS;
    this.#schedule = options.schedule ?? scheduleWithTimeout;
  }

  /**
   * Watches one daemon. The first listener starts the read, and losing the
   * last one stops the poll — an unmounted banner must not keep a daemon busy.
   */
  subscribe(daemon: DaemonConnection, listener: () => void): () => void {
    const login = this.#login(daemon);
    const wasEmpty = login.listeners.size === 0;
    login.listeners.add(listener);
    if (wasEmpty) void this.refresh(daemon);
    return () => {
      login.listeners.delete(listener);
      if (login.listeners.size === 0) clearPoll(login);
    };
  }

  /** `null` means this daemon has not been read yet, not that it is closed. */
  getSnapshot(daemonId: DaemonId): BrowserLoginSnapshot | null {
    return this.#logins.get(daemonId)?.snapshot ?? null;
  }

  /**
   * Reads one daemon's window. Identical reads for the SAME daemon share the
   * one in-flight request; reads for different daemons never do, however alike
   * they look.
   */
  refresh(daemon: DaemonConnection): Promise<BrowserLoginSnapshot> {
    const login = this.#login(daemon);
    const requestGeneration = login.generation;
    if (login.inFlight?.generation === requestGeneration) return login.inFlight.promise;
    const promise = login.port
      .status()
      .then(value => this.#settle(login, requestGeneration, readStatus(value)))
      .catch(caught =>
        this.#settle(login, requestGeneration, unknownFrom(caught, 'Cannot reach the browser-login window.')),
      )
      .finally(() => {
        if (login.inFlight?.promise === promise) login.inFlight = null;
      });
    login.inFlight = { generation: requestGeneration, promise };
    return promise;
  }

  /** Carries out one explicit human intent against one daemon. */
  async act(daemon: DaemonConnection, action: BrowserLoginAction): Promise<BrowserLoginSnapshot> {
    const login = this.#login(daemon);
    // Invalidate any older read of THIS daemon. Its result may still satisfy
    // its own caller, but it must never publish over this action's result.
    const actionGeneration = ++login.generation;
    clearPoll(login);
    try {
      const status = readStatus(await login.port.act(action));
      if (login.generation === actionGeneration) publish(login, status);
      // The POST answers with a status, but the daemon keeps tearing down or
      // starting up after it: read the authoritative state straight back.
      return await this.refresh(daemon);
    } catch (caught) {
      const failed = unknownFrom(caught, 'Browser-login action failed.');
      if (login.generation === actionGeneration) {
        publish(login, failed);
        this.#schedulePoll(login, failed);
      }
      return failed;
    }
  }

  /**
   * Unpairs one daemon: its poll stops, its in-flight reads can no longer
   * publish, and its credentials are dropped. Every other daemon is untouched.
   */
  clearDaemon(daemonId: DaemonId): boolean {
    const login = this.#logins.get(daemonId);
    if (login === undefined) return false;
    this.#invalidate(login);
    login.snapshot = null;
    notify(login);
    login.listeners.clear();
    return this.#logins.delete(daemonId);
  }

  #login(daemon: DaemonConnection): DaemonLogin {
    const existing = this.#logins.get(daemon.daemonId);
    if (existing === undefined) {
      const created: DaemonLogin = {
        connection: daemon,
        port: this.#createPort(daemon),
        listeners: new Set(),
        snapshot: null,
        cancelPoll: null,
        generation: 0,
        inFlight: null,
      };
      this.#logins.set(daemon.daemonId, created);
      return created;
    }
    if (existing.connection.baseUrl === daemon.baseUrl && existing.connection.deviceToken === daemon.deviceToken) {
      return existing;
    }
    // The same daemon, reached a different way: re-paired, rotated token, new
    // origin. A password read over the old connection is not this connection's
    // password, so the snapshot is dropped rather than carried across, and any
    // answer still in flight for the old one is fenced out.
    this.#invalidate(existing);
    existing.connection = daemon;
    existing.port = this.#createPort(daemon);
    existing.snapshot = null;
    notify(existing);
    return existing;
  }

  #invalidate(login: DaemonLogin): void {
    login.generation += 1;
    login.inFlight = null;
    clearPoll(login);
  }

  #settle(login: DaemonLogin, requestGeneration: number, snapshot: BrowserLoginSnapshot): BrowserLoginSnapshot {
    if (login.generation === requestGeneration) {
      publish(login, snapshot);
      this.#schedulePoll(login, snapshot);
    }
    return snapshot;
  }

  #schedulePoll(login: DaemonLogin, snapshot: BrowserLoginSnapshot): void {
    clearPoll(login);
    if (login.listeners.size === 0) return;
    const delayMs = snapshot.state === 'closed' ? this.#closedPollMs : this.#openPollMs;
    login.cancelPoll = this.#schedule(() => {
      void this.refresh(login.connection);
    }, delayMs);
  }
}
