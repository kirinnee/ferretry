/**
 * HOW A SUB-FERRET IS DOING, in the five words a parent's reader needs (docs/pack-mode.md).
 *
 * A ferret's daemon status has sixteen values; the person watching a pack wants to know which of its
 * sub-ferrets are still starting, which are working, which want them, and which have finished — and, for
 * one that failed or stopped, why. Every surface that lists sub-ferrets (the header's indicator, Info's
 * lineage list, the "Started sub-ferret" card in the parent's chat) reads them through this one place, so
 * the three never disagree about the same ferret.
 *
 * A wait that collects a still-running ferret's result stops it with the reason "its result was
 * collected": that is a finish, not a stop, so it reads `done`.
 */

import type { SessionStatus, SessionView } from '@ferretry/protocol';
import { displayCallsign, shortSessionId } from './callsign.ts';

export type SubFerretState = 'starting' | 'working' | 'needs-you' | 'idle' | 'done' | 'failed' | 'stopped';

export interface SubFerretReading {
  readonly state: SubFerretState;
  readonly word: string;
  /** Why, when the daemon said: a failure's reason, what it is waiting on. */
  readonly reason?: string;
}

const WORD: Readonly<Record<SubFerretState, string>> = {
  starting: 'Starting',
  working: 'Working',
  'needs-you': 'Needs you',
  idle: 'At its prompt',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

const STARTING: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['created', 'starting']);
const FAILED: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['failed', 'stalled', 'kill_failed']);
const ASKING: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['awaiting_user', 'awaiting_question']);

/** The reason a wait stops a ferret with once its result is collected (`fy wait`). */
const COLLECTED = /result was collected/iu;

const reading = (state: SubFerretState, reason?: string): SubFerretReading => ({
  state,
  word: WORD[state],
  ...(reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() }),
});

/** How one sub-ferret is doing now. */
export const subFerretState = (view: SessionView): SubFerretReading => {
  const { state } = view;
  if (state.status === 'completed') return reading('done');
  if (state.status === 'stopped')
    return COLLECTED.test(state.reason ?? '') ? reading('done') : reading('stopped', state.reason);
  if (FAILED.has(state.status)) return reading('failed', state.reason);
  if (STARTING.has(state.status)) return reading('starting');
  const asking =
    ASKING.has(state.status) ||
    state.turnState === 'needs-input' ||
    (state.pendingQuestion ?? null) !== null ||
    (state.needsHuman ?? '') !== '';
  if (asking) return reading('needs-you', state.needsHuman ?? state.turnPrompt);
  if (state.turnState === 'your-turn') return reading('idle');
  if (state.status === 'rate_limited') return reading('working', 'rate limited');
  return reading('working');
};

/** A sub-ferret's still at work: starting, working, at its prompt, or waiting on you. */
export const subFerretLive = (reading: SubFerretReading): boolean =>
  reading.state !== 'done' && reading.state !== 'failed' && reading.state !== 'stopped';

/** The name a sub-ferret is called by: its callsign, else its task, else its short id. */
export const subFerretName = (view: SessionView): string =>
  displayCallsign(view.config.teammate) || view.config.name || shortSessionId(view.config.id);

/** The model it runs on, as observed when the harness said, else as it was started. */
export const subFerretModel = (view: SessionView): string | undefined => view.state.observedModel ?? view.config.model;

/** The effort it runs at, as observed, else as launched. */
export const subFerretEffort = (view: SessionView): string | undefined =>
  view.state.observedReasoningEffort ?? view.config.launchReasoningEffort;

/** The sub-ferrets of `parentId` among `sessions`, newest first. */
export const subFerretsOf = (parentId: string, sessions: readonly SessionView[]): readonly SessionView[] =>
  sessions
    .filter(view => view.config.parent === parentId && view.config.id !== parentId)
    .toSorted((left, right) => right.config.createdAt.localeCompare(left.config.createdAt));

/**
 * The header's summary: `3 sub-ferrets · 1 needs you · 1 working`. Only the live states are counted
 * beside the total — a finished one is in the total and in the list.
 */
export const subFerretSummary = (children: readonly SessionView[]): string => {
  const readings = children.map(subFerretState);
  const count = (state: SubFerretState): number => readings.filter(one => one.state === state).length;
  const total = `${children.length} sub-ferret${children.length === 1 ? '' : 's'}`;
  const needs = count('needs-you');
  const working = count('working') + count('starting');
  const failed = count('failed');
  return [
    total,
    needs > 0 ? `${needs} needs you` : '',
    working > 0 ? `${working} running` : '',
    failed > 0 ? `${failed} failed` : '',
  ]
    .filter(Boolean)
    .join(' · ');
};
