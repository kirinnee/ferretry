/**
 * HOW A HELPER IS DOING, in the words a lead's reader needs (docs/pack-mode.md).
 *
 * The daemon's pack table (`GET /v1/ferrets/:ferretId/pack`) already reads each helper into one of four states —
 * `running`, `waiting`, `needs-you`, `ended` — and the ferret's own state (`starting`, `working`, `idle`, `stopped`). Every
 * surface that lists helpers (the panel beside the ferret, the "Started helper" card in the lead's chat) reads them through
 * this one place, so the surfaces never disagree about the same ferret. For a helper that needs you or has ended, the reason
 * is the one line it last said.
 */

import type { PackRow } from '../../contract/index.ts';

type HelperState = PackRow['state'] | 'starting';

export interface HelperReading {
  readonly state: HelperState;
  readonly word: string;
  /** Why, when the daemon said: what it is waiting on, or how it ended. */
  readonly reason?: string;
}

const WORD: Readonly<Record<HelperState, string>> = {
  starting: 'Starting',
  running: 'Working',
  waiting: 'Waiting',
  'needs-you': 'Needs you',
  ended: 'Ended',
};

const reading = (state: HelperState, reason?: string): HelperReading => ({
  state,
  word: WORD[state],
  ...(reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() }),
});

/** How one helper is doing now. */
export const helperState = (row: PackRow): HelperReading => {
  if (row.state === 'ended' || row.state === 'needs-you') return reading(row.state, row.last?.text);
  if (row.ferretState === 'starting') return reading('starting');
  return reading(row.state);
};

/** A helper that is still at work: starting, working, waiting, or waiting on you. */
export const helperLive = (reading: HelperReading): boolean => reading.state !== 'ended';

/** The name a helper is called by. */
export const helperName = (row: PackRow): string => row.name;

/** The model it runs on, as the daemon's table names it. */
export const helperModel = (row: PackRow): string => row.model;

/** The rows of a pack table that are `parentId`'s own children, in tree order. */
export const helpersOf = (parentId: string, rows: readonly PackRow[]): readonly PackRow[] =>
  rows.filter(row => row.parent === parentId && row.id !== parentId);
