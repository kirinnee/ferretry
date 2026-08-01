import type { SessionState } from '@ferretry/protocol';
import { TERMINAL_STATUSES } from '../session/display.ts';

/**
 * What `fy wait` decides on every poll, as a pure function of the session's state.
 *
 * WHY THIS IS ITS OWN MODULE. Blocking until a session finishes means deciding what happens when it
 * never does, and the legacy `kteam wait` decided badly in exactly one place: it returned success for
 * EVERY terminal status. A session that failed, stalled or was stopped exited 0 and the script waiting
 * on it carried on as though the work had been done. That is the false-success shape this migration
 * keeps finding, and it is a decision, not an accident of control flow — so it is written here as a
 * total function over the outcome set, with a test per outcome, rather than as `return`s inside a loop.
 *
 * THE OTHER DECISION IS A DECLARED WAIT. A session parked on a peer or a deadline is NOT stuck: the
 * daemon holds the deadline and will wake it, so waiting is the correct thing to keep doing. A session
 * in `waiting` with no declared wait is the opposite — nobody is going to wake it but a human — and
 * treating those two identically is what made `wait` either hang forever or give up too early.
 */

/**
 * Statuses that mean the session ended WITHOUT completing, including the one that ended badly enough
 * to leave a pane behind.
 *
 * `completed` is deliberately not one of them. It is the only ended status a deliverable gate can still
 * be waiting on: a teammate that claims completion may not have flushed the file yet, so a `--until-marker`
 * wait treats it as "keep waiting, bounded by the deadline" while every status in this list means the
 * file can never arrive.
 */
const DIED: readonly string[] = [...TERMINAL_STATUSES.filter(status => status !== 'completed'), 'kill_failed'];

/** Statuses that mean the session is parked on a human rather than working. */
const PARKED: readonly string[] = ['waiting', 'awaiting_user', 'awaiting_question'];

/** Everything a poll knows. */
export interface WaitObservation {
  readonly state: SessionState;
  /** The deliverable gate, when one was named: whether the file exists as of this poll. */
  readonly marker?: { readonly path: string; readonly present: boolean };
  /** Whether the caller's own deadline has passed. */
  readonly expired: boolean;
}

/**
 * Every way a wait can end, and the one way it does not.
 *
 * Each terminal outcome carries the exit code a script needs to tell them apart. They are deliberately
 * distinct: "the work finished", "the session died", "a human is needed" and "I gave up" are four
 * different things to a caller, and the legacy command answered 0 to the first three.
 */
export type WaitOutcome =
  /** The session reached `completed`, or the deliverable the caller named appeared. */
  | { readonly kind: 'settled'; readonly reason: 'completed' | 'marker' }
  /** The session ended without completing, or ended without ever producing the deliverable. */
  | { readonly kind: 'ended'; readonly status: string; readonly marker?: string }
  /** The session is parked on a human and will not move on its own. */
  | { readonly kind: 'needs-attention'; readonly status: string }
  /** The caller's deadline passed while the session was still going. */
  | { readonly kind: 'timed-out'; readonly status?: string }
  /** The daemon connection failed, independently of what state the session may be in. */
  | {
      readonly kind: 'daemon-unavailable';
      readonly failure: 'unavailable' | 'unresponsive';
      readonly detail: string;
    }
  /** Nothing decided yet. `note` is said ONCE per wait, on stderr, so a long block is never silent. */
  | { readonly kind: 'keep-waiting'; readonly note?: string };

/** The exit code each ended wait reports. */
export function waitExitCode(outcome: Exclude<WaitOutcome, { kind: 'keep-waiting' }>): number {
  switch (outcome.kind) {
    case 'settled':
      return 0;
    // The session died, or died without the deliverable. Legacy answered 0 here; a script that reads
    // 0 as "the work is done" then proceeds on output that was never produced.
    case 'ended':
      return 1;
    // Distinct from a death: nothing is broken, but nothing will happen either until a human replies.
    case 'needs-attention':
      return 3;
    case 'timed-out':
      // 124 is what `timeout(1)` uses, and what the legacy command already reported, so wrappers that
      // already branch on it keep working.
      return 124;
    case 'daemon-unavailable':
      // EX_UNAVAILABLE: the caller can distinguish losing fyd from a session that ended unsuccessfully.
      return 69;
  }
}

/** Notes already said during this wait, so an advisory is never repeated on every poll. */
export interface WaitNotices {
  readonly missingMarker: boolean;
  readonly declaredWait: boolean;
}

/** The declared-wait advisory, in the vocabulary the teammate used to declare it. */
function declaredWaitNote(state: SessionState): string {
  const wait = state.waiting;
  const on = wait?.condition === undefined ? '' : ` on ${wait.condition}`;
  const until = wait?.until === undefined ? ' (open-ended)' : ` until ${wait.until}`;
  return `fy wait: the teammate declared a wait${on}${until}; the daemon will wake it, so this keeps waiting`;
}

/**
 * The decision for one poll, and the notices that decision consumed.
 *
 * The MARKER branch is deliberately the outer one. When a deliverable is named it is the ground truth:
 * a `completed` status without the file keeps waiting (bounded by the caller's deadline), because a
 * teammate claiming completion is a claim and the file is evidence. Only a session that has DIED — and
 * therefore can never produce it — turns that into a failure.
 */
export function decideWait(
  observation: WaitObservation,
  notices: WaitNotices,
): { readonly outcome: WaitOutcome; readonly notices: WaitNotices } {
  const { state, marker, expired } = observation;
  const status = state.status;
  const parked = PARKED.includes(status);
  const declared = state.waiting !== undefined;

  if (marker !== undefined) {
    if (marker.present) return { outcome: { kind: 'settled', reason: 'marker' }, notices };
    if (DIED.includes(status)) return { outcome: { kind: 'ended', status, marker: marker.path }, notices };
    // A session parked on a human can never produce the deliverable on its own, so hand control back
    // rather than blocking until the deadline. A DECLARED wait is the opposite and keeps waiting.
    if (parked && !declared) return { outcome: { kind: 'needs-attention', status }, notices };
    if (expired) return { outcome: { kind: 'timed-out', status }, notices };
    if (status === 'completed' && !notices.missingMarker) {
      return {
        outcome: {
          kind: 'keep-waiting',
          note: `fy wait: the session completed but ${marker.path} is not there yet; still waiting for it`,
        },
        notices: { ...notices, missingMarker: true },
      };
    }
    if (declared && !notices.declaredWait) {
      return {
        outcome: { kind: 'keep-waiting', note: declaredWaitNote(state) },
        notices: { ...notices, declaredWait: true },
      };
    }
    return { outcome: { kind: 'keep-waiting' }, notices };
  }

  if (status === 'completed') return { outcome: { kind: 'settled', reason: 'completed' }, notices };
  if (DIED.includes(status)) return { outcome: { kind: 'ended', status }, notices };
  if (parked && !declared) return { outcome: { kind: 'needs-attention', status }, notices };
  if (expired) return { outcome: { kind: 'timed-out', status }, notices };
  if (declared && !notices.declaredWait) {
    return {
      outcome: { kind: 'keep-waiting', note: declaredWaitNote(state) },
      notices: { ...notices, declaredWait: true },
    };
  }
  return { outcome: { kind: 'keep-waiting' }, notices };
}

/** How an ended wait is explained on stderr. */
export function renderWaitOutcome(outcome: Exclude<WaitOutcome, { kind: 'keep-waiting' }>): string | undefined {
  switch (outcome.kind) {
    case 'settled':
      return undefined;
    case 'ended':
      return outcome.marker === undefined
        ? `fy wait: the session ended as ${outcome.status} rather than completing`
        : `fy wait: the session is ${outcome.status} and ${outcome.marker} never appeared`;
    case 'needs-attention':
      return `fy wait: the session is ${outcome.status} and needs a human before it can go further`;
    case 'timed-out':
      return outcome.status === undefined
        ? 'fy wait: timed out before fyd returned a session state'
        : `fy wait: gave up while the session was still ${outcome.status}`;
    case 'daemon-unavailable':
      return `fy wait: fyd became ${outcome.failure}: ${outcome.detail}`;
  }
}
