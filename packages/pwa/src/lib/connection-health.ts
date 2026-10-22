/**
 * HOW WELL THIS BROWSER CAN REACH EACH PAIRED DAEMON, AS ONE FACT PER DAEMON.
 *
 * Every panel used to report a lost carrier on its own — the transcript, the session, the composer —
 * each with the whole walk's sentence, so one dropped relay socket painted the same paragraph three
 * times. This is the one place that fact lives: the carrier router reports what it measured, the
 * reconnect loop retries on its own schedule, and every surface reads the same state.
 *
 * CONTRACT FILE: the types and constants below are what the UI is built against. The implementation
 * (the reconnect loop and the router wiring) lives beside them.
 */

import type { DaemonId } from './daemon-connection.ts';

/** After this long without a working carrier the UI stops saying "reconnecting" and explains why. */
export const CONNECTION_STALL_MS = 30_000;

/**
 * How long an outage stays UNSAID. A relay socket that drops and is back within a round trip or two is
 * a blip, not news: the reconnect loop has already started, the screen keeps showing the last good
 * data, and a pill that flashes on and off for every one of them taught the owner the app was "ALWAYS
 * reconnecting". Only an outage older than this is shown; the stall banner later is unaffected.
 */
export const RECONNECTING_GRACE_MS = 1_500;

/** One carrier the last attempt tried and why it did not work — one entry per carrier, never per panel. */
export interface CarrierFailure {
  /** The carrier's human label, e.g. "Direct", "Hosted relay", "Your own relay". */
  readonly label: string;
  /** The technical sentence for the details sheet. Never shown outside it. */
  readonly detail: string;
}

/**
 * The most likely reason, read from what the browser and the walk can observe.
 *
 * - `device-offline`: the browser says it has no network (`navigator.onLine === false`).
 * - `daemon-unreachable`: a relay answered but no daemon holds the rendezvous (`4404`), or direct
 *   refused while the device is online — the machine is asleep or its daemon is stopped.
 * - `relay-unreachable`: the device is online and no relay socket could even open.
 * - `unknown`: none of the above can be told apart yet.
 */
export type LikelyCause = 'device-offline' | 'daemon-unreachable' | 'relay-unreachable' | 'unknown';

export type ConnectionHealthState =
  /** Nothing has been measured yet for this daemon: show nothing. */
  | { readonly kind: 'unknown' }
  /** The last request reached the daemon. */
  | { readonly kind: 'connected' }
  | {
      readonly kind: 'reconnecting';
      /** Epoch ms of the first failure in this outage. */
      readonly since: number;
      /** Automatic attempts made so far in this outage (1-based once the first retry ran). */
      readonly attempt: number;
      /** Epoch ms of the next scheduled attempt, or `null` while one is in flight. */
      readonly nextAttemptAt: number | null;
      /** Deduplicated: one entry per carrier from the latest attempt. */
      readonly failures: readonly CarrierFailure[];
      readonly cause: LikelyCause;
      /** `true` once `now - since >= CONNECTION_STALL_MS`; republished when it flips. */
      readonly stalled: boolean;
    };

/** What every surface reads. Owned by the composition root (`store.connectionHealth`). */
export interface ConnectionHealth {
  state(daemonId: DaemonId): ConnectionHealthState;
  /** Called on every state change for that daemon (including `stalled` flipping). */
  subscribe(daemonId: DaemonId, listener: () => void): () => void;
  /** Skip the backoff and try now — the pill's "Retry now", and `online` / foreground / network change. */
  retryNow(daemonId: DaemonId): void;
  /** Fires once each time this daemon goes from `reconnecting` back to `connected`. */
  onRecovered(daemonId: DaemonId, listener: () => void): () => void;
}

/* ---------- the implementation ---------------------------------------------- */

/**
 * The first retry waits between half of this and this; each later one doubles it.
 *
 * UNDER 300 MS, so a recoverable drop is back before anything says it left: the reconnecting line waits
 * {@link RECONNECTING_GRACE_MS}, and a carrier that answers at once (a tunnel, a relay that is still
 * there) is re-dialled and answering well inside it. The doubling still keeps a machine that is really
 * gone from being asked more than once every ten seconds.
 */
export const RECONNECT_BASE_MS = 300;

/** No retry ever waits longer than this, however long the outage. */
export const RECONNECT_CEILING_MS = 10_000;

/**
 * How long the `attempt`-th automatic retry waits (0-based), with EQUAL JITTER: half the capped
 * exponential delay is fixed and half is random. The fixed half keeps a phone from hammering a relay
 * that just came back; the random half keeps every tab of every device that lost the same relay
 * deploy from retrying in lockstep. `random` is `[0, 1)`.
 */
export const reconnectDelayMs = (attempt: number, random: number): number => {
  const capped = Math.min(RECONNECT_CEILING_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 30));
  return capped / 2 + random * (capped / 2);
};

/**
 * What the router saw when no carrier carried a request.
 *
 * Observations, not a verdict: the cause is derived here from them, so the rule lives in one place.
 */
export interface CarrierOutage {
  /** One per carrier tried, in walk order. Duplicates are folded here, not by the reporter. */
  readonly failures: readonly CarrierFailure[];
  /** A relay answered that no daemon holds this rendezvous (`4404`). */
  readonly daemonAbsent: boolean;
  /** At least one relay was tried and NO relay socket ever opened. */
  readonly relaysNeverOpened: boolean;
}

/** What the carrier router tells the health model. It never reads anything back. */
export interface ConnectionHealthReporter {
  /** A request was answered — any status. */
  answered(daemonId: DaemonId): void;
  /** No carrier carried a request. */
  outage(daemonId: DaemonId, outage: CarrierOutage): void;
  /**
   * The daemon answered with something no retry changes — a refused device, a dialect mismatch. Not
   * an outage: the screen that owns that refusal says it, and the loop stops.
   */
  settled(daemonId: DaemonId): void;
  /**
   * Whether the router may DIAL a new session for this daemon on a caller's behalf. `false` while it
   * is reconnecting: then only the loop's own attempt dials, so every panel, stream and terminal
   * retrying on its own schedule cannot turn one outage into a storm of rendezvous arrivals — the
   * storm that used up a relay's per-rendezvous arrival budget and kept the daemon itself out.
   */
  dialAllowed(daemonId: DaemonId): boolean;
}

/** Everything the model reads from the world. Injected so no suite waits on a real clock. */
export interface ConnectionHealthEnvironment {
  readonly now: () => number;
  /** Runs `run` once after `delayMs`; returns how to cancel it. */
  readonly schedule: (run: () => void, delayMs: number) => () => void;
  /** `[0, 1)`. */
  readonly random: () => number;
  /** The browser's own `navigator.onLine`. `true` when nobody can tell. */
  readonly isOnline: () => boolean;
}

/**
 * One REAL read through the router — never a synthetic probe — so a retry that succeeds is a request
 * that succeeded. Its outcome reaches the model through the reporter like any other request's; what
 * the promise says is only that the attempt is over.
 */
export type ReconnectAttempt = (daemonId: DaemonId) => Promise<unknown>;

export const browserConnectionHealthEnvironment = (): ConnectionHealthEnvironment => ({
  now: () => Date.now(),
  schedule: (run, delayMs) => {
    const handle = setTimeout(run, delayMs);
    return () => clearTimeout(handle);
  },
  random: () => Math.random(),
  isOnline: () => globalThis.navigator?.onLine !== false,
});

/** The cause the contract names, from what was observed. Order matters: the device's own word first. */
export const likelyCause = (outage: CarrierOutage, online: boolean): LikelyCause => {
  if (!online) return 'device-offline';
  if (outage.daemonAbsent) return 'daemon-unreachable';
  if (outage.relaysNeverOpened) return 'relay-unreachable';
  return 'unknown';
};

/** One entry per carrier label, the latest detail kept: two hosted relays are still one line to a reader. */
const foldFailures = (failures: readonly CarrierFailure[]): readonly CarrierFailure[] => {
  const byLabel = new Map<string, CarrierFailure>();
  for (const failure of failures) {
    byLabel.delete(failure.label);
    byLabel.set(failure.label, failure);
  }
  return [...byLabel.values()];
};

const UNKNOWN: ConnectionHealthState = { kind: 'unknown' };
const CONNECTED: ConnectionHealthState = { kind: 'connected' };

type Reconnecting = Extract<ConnectionHealthState, { kind: 'reconnecting' }>;

interface DaemonHealth {
  state: ConnectionHealthState;
  readonly listeners: Set<() => void>;
  readonly recovered: Set<() => void>;
  /** Cancels the scheduled retry, while one is scheduled. */
  cancelRetry: (() => void) | undefined;
  /** Cancels the stall flip, while an outage is younger than {@link CONNECTION_STALL_MS}. */
  cancelStall: (() => void) | undefined;
  inFlight: boolean;
  /** Bumped on every outage start and every stop, so a stall timer from an old outage is inert. */
  epoch: number;
}

/**
 * THE ONE PLACE A LOST CARRIER IS A FACT, AND THE LOOP THAT ENDS IT.
 *
 * An outage starts when the router reports that nothing carried a request, and from then on the model
 * retries FOREVER — a phone that slept through a relay deploy, or rode a train through a tunnel, has
 * nothing to gain from a loop that gave up while it was away. The backoff bounds the cost instead: one
 * real read per ten seconds at worst, and `retryNow` for the moments the browser says the network
 * changed. The first answer from ANY request — the loop's or a panel's own — ends the outage, and that
 * is the only thing that does: a `connected` state is never invented.
 */
export class DaemonConnectionHealth implements ConnectionHealth, ConnectionHealthReporter {
  readonly #daemons = new Map<DaemonId, DaemonHealth>();

  constructor(
    private readonly environment: ConnectionHealthEnvironment,
    private readonly attempt: ReconnectAttempt,
  ) {}

  state(daemonId: DaemonId): ConnectionHealthState {
    return this.#daemons.get(daemonId)?.state ?? UNKNOWN;
  }

  subscribe(daemonId: DaemonId, listener: () => void): () => void {
    const health = this.#health(daemonId);
    health.listeners.add(listener);
    return () => health.listeners.delete(listener);
  }

  onRecovered(daemonId: DaemonId, listener: () => void): () => void {
    const health = this.#health(daemonId);
    health.recovered.add(listener);
    return () => health.recovered.delete(listener);
  }

  /** Every daemon currently between a lost carrier and its next answer. */
  reconnecting(): readonly DaemonId[] {
    return [...this.#daemons].filter(([, health]) => health.state.kind === 'reconnecting').map(([id]) => id);
  }

  retryNow(daemonId: DaemonId): void {
    const health = this.#daemons.get(daemonId);
    // COALESCED: an attempt already in flight is the retry this asked for.
    if (health === undefined || health.state.kind !== 'reconnecting' || health.inFlight) return;
    health.cancelRetry?.();
    health.cancelRetry = undefined;
    this.#run(daemonId, health);
  }

  answered(daemonId: DaemonId): void {
    const health = this.#health(daemonId);
    const was = health.state.kind;
    if (was === 'connected') return;
    this.#stop(health);
    this.#publish(health, CONNECTED);
    if (was !== 'reconnecting') return;
    for (const listener of [...health.recovered]) {
      try {
        listener();
      } catch {
        // One surface failing to refresh cannot keep the others from hearing the daemon is back.
      }
    }
  }

  outage(daemonId: DaemonId, outage: CarrierOutage): void {
    const health = this.#health(daemonId);
    const failures = foldFailures(outage.failures);
    const cause = likelyCause(outage, this.environment.isOnline());
    const current = health.state;
    if (current.kind === 'reconnecting') {
      // The same outage, measured again: what was tried and why it failed may have moved; its age has not.
      this.#publish(health, { ...current, failures, cause });
      return;
    }
    health.epoch += 1;
    const since = this.environment.now();
    const epoch = health.epoch;
    health.cancelStall = this.environment.schedule(() => {
      health.cancelStall = undefined;
      const now = health.state;
      if (health.epoch === epoch && now.kind === 'reconnecting') this.#publish(health, { ...now, stalled: true });
    }, CONNECTION_STALL_MS);
    this.#publish(health, {
      kind: 'reconnecting',
      since,
      attempt: 0,
      nextAttemptAt: null,
      failures,
      cause,
      stalled: false,
    });
    // A report that arrived from the loop's OWN attempt is followed by that attempt settling, which
    // schedules the next one; anything else starts the loop here.
    if (!health.inFlight) this.#scheduleNext(daemonId, health);
  }

  dialAllowed(daemonId: DaemonId): boolean {
    return this.state(daemonId).kind !== 'reconnecting';
  }

  settled(daemonId: DaemonId): void {
    const health = this.#daemons.get(daemonId);
    if (health === undefined) return;
    this.#stop(health);
    this.#publish(health, UNKNOWN);
  }

  /**
   * Unpaired or re-paired: nothing is retried for a pairing that no longer exists.
   *
   * The record is RESET rather than deleted: a mounted surface subscribed to it, and a replacement
   * record would be one that surface can never hear from again.
   */
  clearDaemon(daemonId: DaemonId): void {
    const health = this.#daemons.get(daemonId);
    if (health === undefined) return;
    this.#stop(health);
    if (health.state.kind !== 'unknown') this.#publish(health, UNKNOWN);
  }

  #health(daemonId: DaemonId): DaemonHealth {
    const existing = this.#daemons.get(daemonId);
    if (existing !== undefined) return existing;
    const created: DaemonHealth = {
      state: UNKNOWN,
      listeners: new Set(),
      recovered: new Set(),
      cancelRetry: undefined,
      cancelStall: undefined,
      inFlight: false,
      epoch: 0,
    };
    this.#daemons.set(daemonId, created);
    return created;
  }

  #stop(health: DaemonHealth): void {
    health.epoch += 1;
    health.cancelRetry?.();
    health.cancelRetry = undefined;
    health.cancelStall?.();
    health.cancelStall = undefined;
  }

  #scheduleNext(daemonId: DaemonId, health: DaemonHealth): void {
    const current = health.state as Reconnecting;
    const delay = reconnectDelayMs(current.attempt, this.environment.random());
    health.cancelRetry = this.environment.schedule(() => {
      health.cancelRetry = undefined;
      this.#run(daemonId, health);
    }, delay);
    this.#publish(health, { ...current, nextAttemptAt: this.environment.now() + delay });
  }

  #run(daemonId: DaemonId, health: DaemonHealth): void {
    const current = health.state as Reconnecting;
    health.inFlight = true;
    this.#publish(health, { ...current, attempt: current.attempt + 1, nextAttemptAt: null });
    const finish = (): void => {
      health.inFlight = false;
      // Recovered, unpaired or settled while this was in flight: nothing to schedule. Still (or AGAIN —
      // a recovery and a fresh outage can both land under one slow attempt) reconnecting with nothing
      // scheduled: this attempt was the loop's only tick, so it schedules the next.
      if (health.state.kind !== 'reconnecting' || health.cancelRetry !== undefined) return;
      this.#scheduleNext(daemonId, health);
    };
    let pending: Promise<unknown>;
    try {
      pending = this.attempt(daemonId);
    } catch {
      pending = Promise.resolve();
    }
    void pending.then(finish, finish);
  }

  #publish(health: DaemonHealth, next: ConnectionHealthState): void {
    health.state = next;
    for (const listener of [...health.listeners]) listener();
  }
}
