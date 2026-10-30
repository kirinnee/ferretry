import type { SessionStatus } from '@ferretry/protocol';
import { isBusyStatus } from '../../migrate/inflight-report.ts';
import type { AutoResumeCandidate, AutoResumeSubject } from './types.ts';

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
