import type { FerretSummary } from '../../../contract/index.ts';

/**
 * What `fy wait` decides on every poll, as a pure function of the ferret's summary (today's `reads/wait.ts`, over
 * Ferrets' four states).
 *
 * A wait must be able to fail, and its outcomes are distinct: "the work finished", "the ferret ended without finishing",
 * "a human is needed" and "I gave up" are four different things to a script. A ferret that ended without saying
 * `signal done` is `ended`, never a success. A declared wait is not stuck: the daemon holds the deadline, so waiting is
 * the right thing to keep doing; an idle ferret with no declared wait is the opposite, since nobody wakes it but a person.
 */

/** Everything a poll knows. */
export interface WaitObservation {
  readonly ferret: FerretSummary;
  /** The deliverable gate, when one was named: whether the file exists as of this poll. */
  readonly marker?: { readonly path: string; readonly present: boolean };
  /** Whether the caller's own deadline has passed. */
  readonly expired: boolean;
}

export type WaitOutcome =
  /** The ferret said done, or the deliverable the caller named appeared. */
  | { readonly kind: 'settled'; readonly reason: 'completed' | 'marker' }
  /** The ferret ended without finishing, or ended without ever producing the deliverable. */
  | { readonly kind: 'ended'; readonly state: string; readonly marker?: string }
  /** The ferret is at your turn with no declared wait and will not move on its own. */
  | { readonly kind: 'needs-attention'; readonly state: string }
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
    // Distinct from a death: nothing is broken, but nothing will happen either until a human replies.
    case 'needs-attention':
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
  const { ferret, marker, expired } = observation;
  const { state } = ferret;
  const finished = state === 'stopped' && ferret.finishedAt !== undefined;
  const died = state === 'stopped' && !finished;
  const parked = state === 'idle';
  const declared = ferret.waiting !== undefined;
  const keep = (note?: string, used: Partial<WaitNotices> = {}) => ({
    outcome: { kind: 'keep-waiting' as const, ...(note === undefined ? {} : { note }) },
    notices: { ...notices, ...used },
  });
  const declaredNote = () =>
    declared && !notices.declaredWait ? keep(declaredWaitNote(ferret), { declaredWait: true }) : keep();

  if (marker !== undefined) {
    if (marker.present) return { outcome: { kind: 'settled', reason: 'marker' }, notices };
    if (died) return { outcome: { kind: 'ended', state, marker: marker.path }, notices };
    if (parked && !declared) return { outcome: { kind: 'needs-attention', state }, notices };
    if (expired) return { outcome: { kind: 'timed-out', state }, notices };
    if (finished && !notices.missingMarker)
      return keep(`the ferret finished but ${marker.path} is not there yet; still waiting for it`, {
        missingMarker: true,
      });
    return declaredNote();
  }

  if (finished) return { outcome: { kind: 'settled', reason: 'completed' }, notices };
  if (died) return { outcome: { kind: 'ended', state }, notices };
  if (parked && !declared) return { outcome: { kind: 'needs-attention', state }, notices };
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
    case 'needs-attention':
      return `the ferret is ${outcome.state} and needs a human before it can go further`;
    case 'timed-out':
      return outcome.state === undefined
        ? 'timed out before the daemon returned a ferret'
        : `gave up while the ferret was still ${outcome.state}`;
    case 'daemon-unavailable':
      return `the daemon became ${outcome.failure}: ${outcome.detail}`;
  }
}
