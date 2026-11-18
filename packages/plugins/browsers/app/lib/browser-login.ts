/**
 * The daemon-global human browser-login window — a short-lived VNC desktop a
 * person signs into by hand, one per paired daemon.
 *
 * The store keeps NO module singleton. One snapshot, timer, generation counter, in-flight slot
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
 * Decided here, because a single daemon and a single action at a time could
 * never raise it: an action SUPERSEDED while its POST is in flight — by a
 * newer action, an unpair, or a re-pair — stops at its own POST status. It
 * publishes nothing, reads nothing further and schedules nothing. Otherwise an
 * older action's authoritative read lands after a newer one's (publishing
 * pre-action state as the newer action's result), or drags the connection the
 * older action was authorised by back into use after the daemon has moved off
 * it. The fence is symmetric: the action that IS still current re-fences
 * before its own authoritative read, so a read that started during its POST
 * can neither publish afterwards nor be handed to it by the in-flight dedupe.
 *
 * Transport: there is no ambient token and no page origin to fetch from, so the HTTP seam is a port built from the
 * daemon's own guarded client (`GET|POST /v1/browser/login` by route key), which owns authentication.
 *
 * Credentials stay in memory: never storage, never a query string, never this
 * public static bundle.
 */

import { isStepUpRefusal } from '@ferretry/app/ui';
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type BrowserLoginAction,
  BrowserLoginActionSchema,
  type BrowserLoginStatus,
  BrowserLoginStatusSchema,
} from '../../contract/index.ts';
import type { BrowserDaemon } from './scope.ts';

type DaemonId = string;

export const BROWSER_LOGIN_ROUTES = { status: 'GET /v1/browser/login', act: 'POST /v1/browser/login' } as const;

/** Something is happening: poll fast enough for a person to watch it happen. */
export const BROWSER_LOGIN_OPEN_POLL_MS = 2_000;

/** Nothing is open: this is a liveness check, not an animation. */
export const BROWSER_LOGIN_CLOSED_POLL_MS = 30_000;

/** A failed read is deliberately not made to look like a closed window. */
interface BrowserLoginUnknown {
  readonly state: 'unknown';
  readonly error: string;
}

/**
 * The daemon refused the quiet read for want of the passkey step-up (the machine keeps no step-up window, so the read
 * straight after Open is refused). It is NOT a failure and NOT a closed window: the person asked for the window and the
 * result is theirs to see once they confirm. Nothing about the window is known, so nothing about it is drawn.
 */
interface BrowserLoginStepUp {
  readonly state: 'step-up-required';
}

/**
 * What one daemon's login window is doing, or `unknown` when the daemon could
 * not be asked. `null` (see `getSnapshot`) is the third case: not read yet.
 *
 * This is structurally the `BrowserLoginView` the already-ported banner takes,
 * which owns that name; the assignability is asserted by the unit test rather
 * than re-exported, so the barrel keeps one definition of each type.
 */
export type BrowserLoginSnapshot = BrowserLoginStatus | BrowserLoginUnknown | BrowserLoginStepUp;

/**
 * The read/act seam for exactly one paired daemon. It answers with the raw
 * payload: parsing belongs to the store, so no injected port can hand the
 * banner a status the schema never saw.
 */
export interface BrowserLoginPort {
  /** `explicit`: the person pressed for this read, so the daemon may ask for the passkey step-up (otherwise it never does). */
  readonly status: (options?: { readonly explicit?: boolean }) => Promise<unknown>;
  readonly act: (action: BrowserLoginAction) => Promise<unknown>;
}

/** Supplies the port for a daemon the store has not seen before. */
export type BrowserLoginPortFactory = (daemon: BrowserDaemon) => BrowserLoginPort;

/**
 * Builds the port over the typed client already bound to one daemon, so the
 * device credential and the contract guard stay the shell's
 * and this module never constructs a URL or a header of its own.
 */
export const browserLoginPort = (client: Pick<PluginClient, 'call'>): BrowserLoginPort => ({
  // A poll while the panel is mounted is not the person acting, so it is quiet: no passkey card on every load. The
  // daemon's refusal still stands (the banner shows `unknown`), and pressing Open asks at once, as a press always does.
  status: options => client.call(BROWSER_LOGIN_ROUTES.status, { quiet: options?.explicit !== true }),
  // Explicit intent on the wire, validated by the schema: the daemon is told what the human chose, never asked to infer it.
  act: action => client.call(BROWSER_LOGIN_ROUTES.act, { body: BrowserLoginActionSchema.parse(action) }),
});

/** Cancels the poll it was returned from, and nothing else. */
type CancelBrowserLoginPoll = () => void;

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
  /** Injected so an open window's own expiry is deterministic. */
  readonly now?: () => number;
}

interface DaemonLogin {
  connection: BrowserDaemon;
  port: BrowserLoginPort;
  readonly listeners: Set<() => void>;
  snapshot: BrowserLoginSnapshot | null;
  /** The snapshot is the daemon's answer to the person's own confirm: only then may a quiet refusal be outweighed by it. */
  confirmed: boolean;
  cancelPoll: CancelBrowserLoginPoll | null;
  generation: number;
  inFlight: { readonly generation: number; readonly promise: Promise<BrowserLoginSnapshot> } | null;
}

const notify = (login: DaemonLogin): void => {
  for (const listener of login.listeners) listener();
};

const publish = (login: DaemonLogin, snapshot: BrowserLoginSnapshot, confirmed = false): void => {
  login.snapshot = snapshot;
  login.confirmed = confirmed;
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
  readonly #now: () => number;

  constructor(createPort: BrowserLoginPortFactory, options: BrowserLoginStoreOptions = {}) {
    this.#createPort = createPort;
    this.#openPollMs = options.openPollMs ?? BROWSER_LOGIN_OPEN_POLL_MS;
    this.#closedPollMs = options.closedPollMs ?? BROWSER_LOGIN_CLOSED_POLL_MS;
    this.#schedule = options.schedule ?? scheduleWithTimeout;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Watches one daemon. Losing the last listener stops the poll — an unmounted
   * banner must not keep a daemon busy.
   *
   * The kick enforces the invariant that a watched daemon always has either a
   * poll scheduled or a read in flight. That covers the first listener, and
   * also the case a listener count alone misses: subscribing with a REPLACED
   * connection, where the rebind has just dropped the snapshot and cancelled
   * the poll, leaving the listeners that stayed attached blind forever.
   */
  subscribe(daemon: BrowserDaemon, listener: () => void): () => void {
    const login = this.#login(daemon);
    login.listeners.add(listener);
    if (login.cancelPoll === null && login.inFlight === null) void this.#read(login);
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
  refresh(daemon: BrowserDaemon): Promise<BrowserLoginSnapshot> {
    return this.#read(this.#login(daemon));
  }

  /**
   * The person's own "Confirm it's you to see the result": one read that may ask for the passkey step-up. It is fenced
   * like an action (an older read can neither publish over it nor be handed back as its answer), and what it shows is
   * only what the daemon answered after the person said yes — a refusal stays a refusal.
   */
  confirm(daemon: BrowserDaemon): Promise<BrowserLoginSnapshot> {
    const login = this.#login(daemon);
    login.generation += 1;
    login.inFlight = null;
    clearPoll(login);
    return this.#read(login, true);
  }

  /** Carries out one explicit human intent against one daemon. */
  async act(daemon: BrowserDaemon, action: BrowserLoginAction): Promise<BrowserLoginSnapshot> {
    const login = this.#login(daemon);
    // Invalidate any older read of THIS daemon. Its result may still satisfy
    // its own caller, but it must never publish over this action's result.
    const actionGeneration = ++login.generation;
    clearPoll(login);
    try {
      const status = readStatus(await login.port.act(action));
      // Superseded while the POST was in flight — by a newer action, an
      // unpair, or a re-pair. It answers its own caller with what its own POST
      // returned, and touches nothing else: publishing would overwrite a newer
      // result, and reading on would let a connection the entry has already
      // moved off reinstall itself as the one this daemon is bound to.
      if (login.generation !== actionGeneration) return status;
      publish(login, status);
      // The POST answers with a status, but the daemon keeps tearing down or
      // starting up after it: read the authoritative state straight back.
      //
      // The read is fenced first. Any read that started while the POST was in
      // flight observed the daemon before this action applied, so it must be
      // unable to publish afterwards AND unable to be handed back here by the
      // in-flight dedupe as though it were this action's authoritative answer.
      login.generation += 1;
      return await this.#read(login);
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

  #login(daemon: BrowserDaemon): DaemonLogin {
    const existing = this.#logins.get(daemon.daemonId);
    if (existing === undefined) {
      const created: DaemonLogin = {
        connection: daemon,
        port: this.#createPort(daemon),
        listeners: new Set(),
        snapshot: null,
        confirmed: false,
        cancelPoll: null,
        generation: 0,
        inFlight: null,
      };
      this.#logins.set(daemon.daemonId, created);
      return created;
    }
    if (existing.connection.client === daemon.client) {
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

  /**
   * The one read path, and it takes the ENTRY rather than a connection.
   * `#login` is the only place a daemon may be (re)bound to a connection, and
   * only a public call reaches it, so no continuation held by an older
   * action, poll or listener can rebind the daemon it was started under.
   */
  #read(login: DaemonLogin, explicit = false): Promise<BrowserLoginSnapshot> {
    const requestGeneration = login.generation;
    if (login.inFlight?.generation === requestGeneration) return login.inFlight.promise;
    const promise = login.port
      .status(explicit ? { explicit } : undefined)
      .then(value => this.#settle(login, requestGeneration, readStatus(value), explicit))
      .catch(caught =>
        this.#settle(
          login,
          requestGeneration,
          // A step-up refusal is the daemon's yes withheld, not a broken read: it says so and offers the confirm.
          isStepUpRefusal(caught)
            ? { state: 'step-up-required' }
            : unknownFrom(caught, 'Cannot reach the browser-login window.'),
          explicit,
        ),
      )
      .finally(() => {
        if (login.inFlight?.promise === promise) login.inFlight = null;
      });
    login.inFlight = { generation: requestGeneration, promise };
    return promise;
  }

  #invalidate(login: DaemonLogin): void {
    login.generation += 1;
    login.inFlight = null;
    clearPoll(login);
  }

  #settle(
    login: DaemonLogin,
    requestGeneration: number,
    snapshot: BrowserLoginSnapshot,
    explicit: boolean,
  ): BrowserLoginSnapshot {
    if (login.generation !== requestGeneration) return snapshot;
    const held = this.#heldConfirmedWindow(login, snapshot, explicit);
    if (held !== null) {
      // A quiet read the daemon refused for want of the step-up says nothing about the window the person already saw
      // after their own confirm, so it neither replaces nor downgrades it; polling goes on so its expiry is noticed.
      this.#schedulePoll(login, held);
      return held;
    }
    // Only the daemon's answer to the person's own confirm is ever held against a later quiet refusal.
    publish(login, snapshot, explicit);
    this.#schedulePoll(login, snapshot);
    return snapshot;
  }

  /**
   * The window the person confirmed to see, while a quiet refusal would otherwise flip it back (a machine that keeps no
   * step-up window refuses every quiet read, even right after a confirm). Never anything the daemon did not return to
   * the explicit read, and gone the moment its own `expiresAt` passes or any other answer arrives.
   */
  #heldConfirmedWindow(
    login: DaemonLogin,
    incoming: BrowserLoginSnapshot,
    explicit: boolean,
  ): BrowserLoginSnapshot | null {
    const current = login.snapshot;
    if (explicit || !login.confirmed || incoming.state !== 'step-up-required') return null;
    if (current === null || (current.state !== 'open' && current.state !== 'closing')) return null;
    return Date.parse(current.expiresAt) > this.#now() ? current : null;
  }

  #schedulePoll(login: DaemonLogin, snapshot: BrowserLoginSnapshot): void {
    clearPoll(login);
    if (login.listeners.size === 0) return;
    // A refused read waits on a press, so it is polled like a closed window, not like something happening.
    const delayMs =
      snapshot.state === 'closed' || snapshot.state === 'step-up-required' ? this.#closedPollMs : this.#openPollMs;
    login.cancelPoll = this.#schedule(() => {
      void this.#read(login);
    }, delayMs);
  }
}
