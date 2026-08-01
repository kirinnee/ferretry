import type { SessionStatus } from '@ferretry/protocol';
import type { SessionId } from '../../session-id.ts';
import type { DeclaredWait } from '../signal/types.ts';

/**
 * The per-daemon watcher that makes a declared wait end.
 *
 * WHY THIS SLICE EXISTS. `signal waiting` records a park and suspends the supervision that would
 * otherwise nudge or reap the session. Until this slice landed, nothing ever un-parked one: the wait
 * was written, the reflex layer stood down, and the only thing that noticed was the warden detector,
 * which flags `declared_wait_overdue` — visible, but not woken. A park that never ends is the
 * park-loop the feature exists to prevent, inverted.
 *
 * THE STATE HERE IS PER-DAEMON BY CONSTRUCTION. There is no module-level registry and no shared
 * handle: one `SessionMonitorService` per daemon process, holding its own heartbeat marks and its own
 * tick ledger, reading its own storage. One daemon cannot tick another's sessions because it has no
 * way to name them — the roster port is the only source of ids, and an adapter builds it from the
 * state home this process opened.
 *
 * WHAT IT IS NOT, yet. kteam's `monitorLoop` is 687 lines: pane snapshots, transcript tailing, the
 * stall reflex, the turn ceiling, quota polling and the stale-marker refusal all ride the same tick.
 * This slice carries ONE of those responsibilities — `serviceWaiting` — and the rest are still GAP
 * rows in `docs/migration/surveys/session-manager-map.md` §F. The loop is deliberately shaped to take
 * them: a tick is a plan over a roster, and another responsibility is another planner.
 */

/** One parked session, as a tick reads it. Sessions that are not parked never reach the planner. */
export interface ParkedSession {
  readonly id: SessionId;
  readonly status: SessionStatus;
  readonly waiting: DeclaredWait;
}

/** Why a park ended, which is not the same question as when. */
export type WaitExpiryBasis =
  /** The deadline the teammate declared, as clamped when the park was accepted. */
  | 'declared'
  /** No deadline was declared, so the daemon's own backstop ended it. */
  | 'backstop'
  /**
   * The park's own timestamps would not parse, so no deadline could be established.
   *
   * TREATED AS ELAPSED, deliberately. A park suspends the nudge, the stall reflex and the turn
   * ceiling, so an unreadable park is supervision switched off for a length of time nobody can state.
   * Waking is the fail-closed direction: it costs an interrupted teammate one message, while the
   * benign reading costs an unsupervised session for however long the damage persists.
   */
  | 'unreadable';

/**
 * When a park ends, and on whose authority.
 *
 * A union rather than an optional number, so "no deadline could be established" cannot be read as
 * "the deadline is zero" — an epoch-zero deadline would report every damaged park as elapsed for the
 * right answer by accident, and every future refinement of the arithmetic as elapsed by mistake.
 */
export type WaitDeadline =
  | { readonly atMs: number; readonly basis: 'declared' | 'backstop' }
  | { readonly atMs?: undefined; readonly basis: 'unreadable' };

/** A park the tick decided has ended, and the account of it the wake carries. */
export interface WaitExpiry {
  readonly basis: WaitExpiryBasis;
  /** The one-line reason journalled onto the `session.waiting_cleared` transition. */
  readonly reason: string;
  /** What the teammate is told when the pane is nudged back into the task. */
  readonly nudge: string;
  readonly elapsedSeconds: number;
}

/** The proof that a park is being watched, republished on the heartbeat interval. */
export interface WaitHeartbeat {
  readonly at: string;
  readonly since: string;
  readonly until: string | undefined;
  readonly condition: string | undefined;
  readonly elapsedSeconds: number;
  /**
   * When this park will be woken, backstop included.
   *
   * Published so a reader can tell a park that is merely long from a loop that has stopped: a file
   * whose `at` is older than its own `expiresAt` is a wake that did not fire.
   */
  readonly expiresAt: string | undefined;
  readonly remainingSeconds: number | undefined;
}

/**
 * What one tick decided about one parked session.
 *
 * A record of independent actions rather than a union, because a tick can legitimately do two things
 * at once — hold a status the record disagrees with AND republish a heartbeat — and forcing them into
 * one variant would either lose an action or multiply the cases.
 */
export interface WaitTickPlan {
  /** When set, the park has ended and nothing else in this plan applies. */
  readonly expiry?: WaitExpiry | undefined;
  /** Whether the record's status must be put back to `waiting`. */
  readonly hold: boolean;
  readonly heartbeat?: WaitHeartbeat | undefined;
}

/**
 * The wait domain, as the monitor drives it.
 *
 * Every method is the SIGNAL slice's own arithmetic reached through a port, never a reimplementation:
 * ending a park credits the time back against the turn ceiling and re-anchors the activity ledger,
 * and a second copy of that would drift from the one `signal working` and `endPeerWait` share.
 */
export interface MonitorWaits {
  /** Every session this daemon holds that is currently parked. */
  parked(): Promise<readonly ParkedSession[]>;
  /**
   * Ends a park whose deadline has passed, and reports the wait it actually cleared.
   *
   * The deadline is RE-CHECKED under the slice's own lock rather than trusted from the plan: the
   * session may have been un-parked and re-parked on a longer wait between the two, and clearing then
   * would wake a teammate that is still waiting for something.
   */
  expire(id: SessionId, nowMs: number, expiry: WaitExpiry): Promise<DeclaredWait | undefined>;
  /**
   * Puts a parked session's status back to `waiting`.
   *
   * `state.waiting` — not the status — is the authority for a park, because other domains recompute
   * the status from what they see. Without the hold, the very tool result of `signal waiting` erases
   * the park from every surface that reads the status, while the wait itself is still in force.
   */
  hold(id: SessionId): Promise<boolean>;
}

/** Where a heartbeat is published so a human, the warden or another process can read it. */
export interface WaitHeartbeatSink {
  publish(id: SessionId, beat: WaitHeartbeat): Promise<void>;
}

/**
 * Telling a woken teammate that its wait is over.
 *
 * Clearing the record is not the wake: the agent is sitting at an idle prompt, and nothing in the
 * state document reaches it. `sendId` is derived from the park rather than generated, so a wake
 * retried after a daemon restart is the same send and the harness sees one message, not two.
 */
export interface MonitorNudge {
  deliver(id: SessionId, sendId: string, message: string): Promise<void>;
}

/** The tick's own lateness, measured on a clock that cannot jump. */
export interface MonitorMonotonicClock {
  elapsedMs(): number;
}

/** What one completed tick did, returned so the loop can publish it and a test can assert on it. */
export interface MonitorTickReport {
  readonly at: string;
  /** Ticks completed by this daemon since it started, including this one. */
  readonly tick: number;
  /** Monotonic milliseconds since the previous tick. `undefined` on the first. */
  readonly sinceLastTickMs: number | undefined;
  readonly parked: number;
  readonly expired: readonly string[];
  readonly heartbeats: readonly string[];
  readonly held: readonly string[];
  /** Per-session failures. One session's failure never abandons the rest of the tick. */
  readonly failures: ReadonlyMap<string, string>;
}

/**
 * The monitor loop, as the composition root drives it.
 *
 * A port rather than the adapter class, because the mount table is `src/lib` and may not reach into
 * `src/adapters`. It carries its own cadence for the reason the self-check tick does: the number the
 * timer fires on IS the number the overdue rule measures against, so a composition root that chose
 * its own would make every on-time tick look late.
 */
export interface MonitorLoop {
  readonly intervalMs: number;
  /** Marks the loop as running. Before this, its health record says it is not. */
  arm(): void;
  /** One tick, with its outcome published. Never rejects — a background timer must not take the
   *  daemon down, and the failure is carried by the record instead. */
  run(): Promise<MonitorTickReport | undefined>;
  /**
   * Disarms the loop and republishes the record saying so, WITHOUT ticking.
   *
   * A shutdown runs after the storage it would read is already closed, so the last thing the record
   * hears must be a statement, not another attempt. Leaving the previous tick's `armed: true` behind
   * would tell the next reader that a loop is watching these parks when the process is gone.
   */
  close(): Promise<void>;
}

/**
 * The loop's own health, which is the answer to "did a tick get missed".
 *
 * `overdue` is the whole point of publishing this. A monitor that silently stops looks exactly like a
 * fleet with nothing parked, so the record states when it last ran and how late that makes it — the
 * same shape the daemon self-check already uses for its own tick.
 */
export interface MonitorHealth {
  /** Whether the loop is armed at all. A disarmed loop is not a healthy one that found nothing. */
  readonly armed: boolean;
  readonly ticks: number;
  readonly lastTickAt: string | undefined;
  /** Monotonic milliseconds since the last completed tick, or since arming when none has completed. */
  readonly sinceLastTickMs: number;
  readonly overdue: boolean;
  readonly parked: number;
  /** Consecutive ticks that threw outright, as distinct from a tick with per-session failures. */
  readonly consecutiveFailures: number;
  readonly lastFailure: string | undefined;
}
