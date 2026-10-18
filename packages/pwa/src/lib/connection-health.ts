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
