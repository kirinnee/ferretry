import { parkedSeconds } from '../signal/policy.ts';
import type { DeclaredWait } from '../signal/types.ts';
import { PROTECTED_SIGNAL_STATUSES } from '../signal/types.ts';
import { declaredWaitDeadlineMs } from '../../warden/detect.ts';
import { instantMs, isoFromMs } from '../../warden/time.ts';
import type { SessionId } from '../../session-id.ts';
import type { SessionMonitorSettings } from './settings.ts';
import type { ParkedSession, WaitDeadline, WaitExpiry, WaitHeartbeat, WaitTickPlan } from './types.ts';

/**
 * The pure decisions one monitor tick makes, with no clock and no filesystem of their own.
 *
 * Everything here is a function of the values handed to it, which is what makes the properties that
 * matter testable without a timer: a park always ends, a park with unreadable timestamps ends
 * IMMEDIATELY rather than never, and a heartbeat is published on its own interval rather than on
 * every tick.
 */

/** The condition as it reads in a sentence written for the teammate that declared it. */
function condition(wait: DeclaredWait): string {
  return (
    wait.condition ?? (wait.peer === undefined ? 'no condition given' : `a reply from ${wait.peerName ?? wait.peer}`)
  );
}

/**
 * When a park ends, and on whose authority.
 *
 * The instant itself comes from the warden's own `declaredWaitDeadlineMs`, so the deadline the
 * monitor enforces is by construction the one the detector reports overdue. Only the BASIS is added
 * here: the wake has to tell a teammate whether its own deadline elapsed or the daemon's backstop
 * ended an open-ended park, and those are different things to be told.
 */
export function waitDeadline(wait: DeclaredWait, settings: SessionMonitorSettings): WaitDeadline {
  const atMs = declaredWaitDeadlineMs(wait, settings.backstopMs);
  if (atMs === undefined) return { basis: 'unreadable' };
  return { atMs, basis: instantMs(wait.until) === undefined ? 'backstop' : 'declared' };
}

/** The account of an ended park: what the journal records, and what the teammate is told. */
export function waitExpiry(wait: DeclaredWait, deadline: WaitDeadline, nowMs: number): WaitExpiry {
  const detail = condition(wait);
  const reason =
    deadline.basis === 'declared'
      ? `declared wait elapsed (${detail})`
      : deadline.basis === 'backstop'
        ? `open-ended wait hit the backstop (${detail})`
        : 'declared wait has unreadable timestamps and could not be given a deadline';
  return {
    basis: deadline.basis,
    reason,
    // The teammate is told the condition it named, never the mechanism: a park ended by the backstop
    // and one ended by its own deadline both mean "go and look at the thing you were waiting for".
    nudge: `The wait you declared has elapsed (${detail}). Re-check the condition and continue the task.`,
    elapsedSeconds: parkedSeconds(wait, nowMs),
  };
}

/** The heartbeat a still-running park publishes, carrying the deadline it will be woken at. */
export function waitHeartbeat(wait: DeclaredWait, deadline: WaitDeadline, nowMs: number): WaitHeartbeat {
  return {
    at: isoFromMs(nowMs),
    since: wait.since,
    until: wait.until,
    condition: wait.condition,
    elapsedSeconds: parkedSeconds(wait, nowMs),
    expiresAt: deadline.atMs === undefined ? undefined : isoFromMs(deadline.atMs),
    remainingSeconds: deadline.atMs === undefined ? undefined : Math.max(0, Math.round((deadline.atMs - nowMs) / 1000)),
  };
}

/**
 * Whether this tick republishes a park's heartbeat.
 *
 * A mark in the FUTURE republishes rather than waits it out. The mark is a wall-clock reading, so a
 * clock that stepped backwards would otherwise silence the heartbeat for the size of the step — and a
 * silent heartbeat is indistinguishable from a stopped loop, which is the one thing this file exists
 * to keep distinguishable.
 */
export function heartbeatDue(lastBeatMs: number | undefined, nowMs: number, settings: SessionMonitorSettings): boolean {
  if (lastBeatMs === undefined) return true;
  const elapsed = nowMs - lastBeatMs;
  return elapsed < 0 || elapsed >= settings.heartbeatIntervalMs;
}

/**
 * What one tick does about one parked session.
 *
 * An ended park short-circuits the rest: holding the status of a session that is being woken, or
 * publishing a heartbeat for a park that no longer exists, would both write a record contradicted by
 * the transition made in the same tick.
 */
export function planWaitTick(
  session: ParkedSession,
  lastBeatMs: number | undefined,
  nowMs: number,
  settings: SessionMonitorSettings,
): WaitTickPlan {
  const deadline = waitDeadline(session.waiting, settings);
  if (deadline.atMs === undefined || nowMs >= deadline.atMs)
    return { expiry: waitExpiry(session.waiting, deadline, nowMs), hold: false };
  return {
    // A protected status is a verdict some other path already reached, and a park must never write
    // over one — the same rule that stops `signal waiting` being declared from a stopped session.
    hold: session.status !== 'waiting' && !PROTECTED_SIGNAL_STATUSES.has(session.status),
    ...(heartbeatDue(lastBeatMs, nowMs, settings)
      ? { heartbeat: waitHeartbeat(session.waiting, deadline, nowMs) }
      : {}),
  };
}

/**
 * Whether the loop has missed a tick.
 *
 * One whole interval of grace on top of the interval itself, so a tick merely delayed by a slow
 * filesystem read is not reported as a missed one; anything beyond that is a loop that is not running
 * often enough to hold a deadline it promised to hold.
 */
export function tickOverdue(sinceLastTickMs: number, settings: SessionMonitorSettings): boolean {
  return sinceLastTickMs > settings.tickIntervalMs + settings.tickGraceMs;
}

/**
 * The idempotency key a wake's nudge is sent under.
 *
 * Derived from the park it ends rather than generated, so the same wake retried after a daemon
 * restart is the SAME send: the ledger recognises it and the harness sees one message. A generated
 * key would make every retry a new turn, which is how a woken teammate ends up reading its wake
 * notice three times.
 */
export function wakeSendId(id: SessionId, wait: DeclaredWait): string {
  return `wake:${id}:${wait.since}`;
}
