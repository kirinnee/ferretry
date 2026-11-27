import type { SessionStatus } from '../../protocol/session.ts';
import type { AutoResumeCandidate, AutoResumeSubject } from './types.ts';

/**
 * A copy of today's `isBusyStatus` (today's in-flight report of the move code, Ferrets' own, which ferrets-c ports):
 * the session is working a turn right now.
 */
const busyStatuses: ReadonlySet<SessionStatus> = new Set([
  'starting',
  'running',
  'thinking',
  'tool_running',
  'retrying',
]);

function isBusyStatus(status: SessionStatus): boolean {
  return busyStatuses.has(status);
}

/** Why a skipped session is skipped, in the words the app shows. */
export function couldNotAutoResume(reason: string): string {
  return `couldn't auto-resume: ${reason}`;
}

/**
 * Whether a candidate is still owed a resume, judged from the session as it reads NOW.
 *
 * The settle that created the candidate left the session `failed`. Anything else means a person or
 * another path got there first — a revive, a stop, a completion — and that decision stands: an
 * owner-stopped session stays stopped.
 */
export function stillOwed(subject: AutoResumeSubject | undefined): boolean {
  return subject !== undefined && subject.status === 'failed';
}

/**
 * What a resume rejects with when it was REFUSED because the ferret is no longer owed it (the `expect` judged under the
 * ferret's own queue said no): the one refusal the pass may stand down on, and only when the ferret is up (see
 * {@link isUpElsewhere}). Any other rejection (a gate, a failed launch) is a ferret that was not brought back.
 */
export class NoLongerOwed extends Error {
  override readonly name = 'NoLongerOwed';
}

/** The registry states of a ferret that is up (or on its way up): somebody brought it back. */
const UP_STATES: ReadonlySet<string> = new Set(['starting', 'working', 'idle']);

/**
 * Whether the ferret is UP, read fresh after a {@link NoLongerOwed} refusal: another path really resumed it first and
 * this one has nothing left to do. A ferret still `failed` (owed), `stopped` (the owner's stop) or gone is not.
 * `starting` counts as up only because the refusal says another path took it: a launch that THIS pass's own resume
 * failed leaves it `starting` too, and that rejects with something else.
 */
export function isUpElsewhere(subject: AutoResumeSubject | undefined): boolean {
  return subject !== undefined && UP_STATES.has(subject.status);
}

/** Candidates inside the age window, newest record per session. */
export function freshCandidates(
  candidates: readonly AutoResumeCandidate[],
  nowMs: number,
  maxAgeMs: number,
): readonly AutoResumeCandidate[] {
  const byId = new Map<string, AutoResumeCandidate>();
  for (const candidate of candidates) {
    const at = Date.parse(candidate.at);
    if (!Number.isFinite(at) || nowMs - at > maxAgeMs) continue;
    const previous = byId.get(candidate.id);
    if (previous === undefined || Date.parse(previous.at) <= at) byId.set(candidate.id, candidate);
  }
  return [...byId.values()];
}

/**
 * What a revived agent is told, or `undefined` for nothing.
 *
 * The restart rule (restart-notice.ts) with one difference: after a host crash there is no in-flight
 * inventory to read, so a mid-turn session is told plainly that what it was running could not be
 * checked. An idle auto session is sent a one-line "nothing was interrupted" so the resume domain
 * does not type its default "continue the assigned task" prompt over finished work; an idle
 * interactive session just gets its terminal back.
 */
export function bootNotice(status: string, mode: 'auto' | 'interactive'): string | undefined {
  if (isBusyStatus(status as SessionStatus))
    return (
      'Ferretry resumed you after the machine restarted mid-turn, so what was running could not be checked. ' +
      'Your conversation was resumed as it was. Before re-running anything, check what state your last ' +
      'commands left behind.'
    );
  return mode === 'auto'
    ? 'Ferretry resumed you after the machine restarted, and nothing was interrupted. Your conversation was ' +
        'resumed as it was; there is nothing to re-run.'
    : undefined;
}

/**
 * What the availability port throws when Runtimes' answer did not come (a hang past the kernel's bound, a throw, garbage):
 * at boot Runtimes may still be waking, so that is "not yet", not "no". The pass asks again after each of
 * {@link LOST_ANSWER_RETRY_MS}, off its worker slots, then skips the ferret with this message as it always did. Runtimes'
 * OWN no is never this.
 */
export class AnswerLost extends Error {
  override readonly name = 'AnswerLost';
}

/** How long the pass waits before each further ask after a lost answer: two more asks, then it gives up (fail closed). */
export const LOST_ANSWER_RETRY_MS: readonly number[] = [3_000, 9_000];
