import type { FerretSummary, FyEvent } from '../../../contract/index.ts';

/**
 * What `fy wait` decides on every poll, as a pure function of the ferret's summary (today's `reads/wait.ts`, over
 * Ferrets' four states).
 *
 * A wait must be able to fail, and its outcomes are distinct: "the work finished", "the ferret ended without finishing",
 * and "I gave up" are three different things to a script. A ferret that ended without saying `signal done` is
 * `ended`, never a success. An idle ferret is between turns, not finished: a lead waiting on a helper must not return
 * early, so an idle ferret, declared wait or not, keeps the wait going until it settles, ends or the caller's deadline.
 * What does end the wait early is a ferret that asks for a person (`signal help`): idle is a ferret between turns, a
 * request is one that cannot go on without an answer.
 */

/** The journal event a ferret's `signal help` leaves, and the one a wait looks for. */
const HELP_EVENT = 'interaction.help';

/** What a help event asks, in the ferret's own words (its `reason`, or the question it also journals). */
export function helpRequest(events: readonly FyEvent[]): string | undefined {
  const asked = events.filter(event => event.type === HELP_EVENT).at(-1);
  if (asked === undefined) return undefined;
  const data = asked.data as { reason?: unknown; message?: unknown } | null | undefined;
  const words = [data?.reason, data?.message].find((word): word is string => typeof word === 'string' && word !== '');
  return words ?? 'the ferret asked for help';
}

/** Everything a poll knows. */
export interface WaitObservation {
  readonly ferret: FerretSummary;
  /** The deliverable gate, when one was named: whether the file exists as of this poll. */
  readonly marker?: { readonly path: string; readonly present: boolean };
  /** Whether the caller's own deadline has passed. */
  readonly expired: boolean;
  /** What the ferret asked of a person since this wait began (`signal help`), when it did. */
  readonly request?: string;
}

export type WaitOutcome =
  /** The ferret said done, or the deliverable the caller named appeared. */
  | { readonly kind: 'settled'; readonly reason: 'completed' | 'marker' }
  /** The ferret ended without finishing, or ended without ever producing the deliverable. */
  | { readonly kind: 'ended'; readonly state: string; readonly marker?: string }
  /** The ferret asked for a person and cannot go on without an answer. */
  | { readonly kind: 'needs-human'; readonly state: string; readonly request: string }
  /** The caller's deadline passed while the ferret was still going. */
  | { readonly kind: 'timed-out'; readonly state?: string }
  /** The daemon connection failed, independently of what state the ferret may be in. */
  | { readonly kind: 'daemon-unavailable'; readonly failure: 'unavailable' | 'unresponsive'; readonly detail: string }
  /** Nothing decided yet. `note` is said ONCE per wait, on stderr, so a long block is never silent. */
  | { readonly kind: 'keep-waiting'; readonly note?: string };

export type EndedWait = Exclude<WaitOutcome, { kind: 'keep-waiting' }>;

/** The exit code each ended wait reports. */
export function waitExitCode(outcome: EndedWait): number {
  switch (outcome.kind) {
    case 'settled':
      return 0;
    case 'ended':
      return 1;
    // v4's code for a ferret that needs a person: a script branches on it to answer, not to retry.
    case 'needs-human':
      return 3;
    // What timeout(1) uses.
    case 'timed-out':
      return 124;
    // EX_UNAVAILABLE: losing the daemon is not a ferret that ended unsuccessfully.
    case 'daemon-unavailable':
      return 69;
  }
}

/** Notes already said during this wait, so an advisory is never repeated on every poll. */
export interface WaitNotices {
  readonly missingMarker: boolean;
  readonly declaredWait: boolean;
  readonly idle: boolean;
}

const declaredWaitNote = (ferret: FerretSummary): string => {
  const wait = ferret.waiting;
  const on = wait?.condition === undefined ? '' : ` on ${wait.condition}`;
  const until = wait?.until === undefined ? ' (open-ended)' : ` until ${wait.until}`;
  return `the ferret declared a wait${on}${until}; the daemon will wake it, so this keeps waiting`;
};

/**
 * The decision for one poll, and the notices that decision consumed.
 *
 * The MARKER branch is the outer one. When a deliverable is named it is the ground truth: a finished ferret without the
 * file keeps waiting (bounded by the caller's deadline), because saying done is a claim and the file is evidence. Only
 * a ferret that ended without finishing — and therefore can never produce it — turns that into a failure.
 */
export function decideWait(
  observation: WaitObservation,
  notices: WaitNotices,
): { readonly outcome: WaitOutcome; readonly notices: WaitNotices } {
  const { ferret, marker, expired, request } = observation;
  const { state } = ferret;
  const finished = state === 'stopped' && ferret.finishedAt !== undefined;
  const died = state === 'stopped' && !finished;
  const idle = state === 'idle';
  const declared = ferret.waiting !== undefined;
  const keep = (note?: string, used: Partial<WaitNotices> = {}) => ({
    outcome: { kind: 'keep-waiting' as const, ...(note === undefined ? {} : { note }) },
    notices: { ...notices, ...used },
  });
  const declaredNote = () => {
    if (declared && !notices.declaredWait) return keep(declaredWaitNote(ferret), { declaredWait: true });
    if (idle && !declared && !notices.idle)
      return keep('the ferret is idle between turns; this keeps waiting for it to finish', { idle: true });
    return keep();
  };

  if (marker !== undefined) {
    if (marker.present) return { outcome: { kind: 'settled', reason: 'marker' }, notices };
    if (died) return { outcome: { kind: 'ended', state, marker: marker.path }, notices };
    if (request !== undefined) return { outcome: { kind: 'needs-human', state, request }, notices };
    if (expired) return { outcome: { kind: 'timed-out', state }, notices };
    if (finished && !notices.missingMarker)
      return keep(`the ferret finished but ${marker.path} is not there yet; still waiting for it`, {
        missingMarker: true,
      });
    return declaredNote();
  }

  if (finished) return { outcome: { kind: 'settled', reason: 'completed' }, notices };
  if (died) return { outcome: { kind: 'ended', state }, notices };
  if (request !== undefined) return { outcome: { kind: 'needs-human', state, request }, notices };
  if (expired) return { outcome: { kind: 'timed-out', state }, notices };
  return declaredNote();
}

/** How an ended wait is explained on stderr; the caller prefixes the command name. */
export function renderWaitOutcome(outcome: EndedWait): string | undefined {
  switch (outcome.kind) {
    case 'settled':
      return undefined;
    case 'ended':
      return outcome.marker === undefined
        ? `the ferret ended as ${outcome.state} without saying it was done`
        : `the ferret is ${outcome.state} and ${outcome.marker} never appeared`;
    case 'needs-human':
      return `the ferret is asking for a person: ${outcome.request}`;
    case 'timed-out':
      return outcome.state === undefined
        ? 'timed out before the daemon returned a ferret'
        : `gave up while the ferret was still ${outcome.state}`;
    case 'daemon-unavailable':
      return `the daemon became ${outcome.failure}: ${outcome.detail}`;
  }
}
