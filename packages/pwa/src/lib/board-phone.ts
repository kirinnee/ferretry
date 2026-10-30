/**
 * THE PHONE BOARD'S PURE PARTS: which lane a swipe or a key lands on, and how many cards need the owner.
 *
 * The phone shows one lane at a time under a chip strip; these functions decide what the strip does and
 * never touch the DOM, the URL or the clock, so each is a plain value-to-value test.
 */

import type { BoardCounts } from '@ferretry/protocol';
import type { BoardGroupOf } from './board-view.ts';

/** How far a swipe must travel sideways to switch lanes, in CSS pixels. */
export const SWIPE_DISTANCE = 56;
/** A swipe is sideways when it travels this many times farther across than up or down. */
const SWIPE_DOMINANCE = 1.5;

export type LaneStep = -1 | 1;

/** The lane a finished drag of the finger points at: next (swipe left), previous (swipe right), or none. */
export const swipeStep = (dx: number, dy: number): LaneStep | null => {
  if (Math.abs(dx) < SWIPE_DISTANCE) return null;
  if (Math.abs(dx) < Math.abs(dy) * SWIPE_DOMINANCE) return null;
  return dx < 0 ? 1 : -1;
};

/** The lane a key moves to: the arrows step, Home and End jump; any other key means nothing. */
export const keyStep = (key: string): LaneStep | 'first' | 'last' | null => {
  if (key === 'ArrowRight') return 1;
  if (key === 'ArrowLeft') return -1;
  if (key === 'Home') return 'first';
  if (key === 'End') return 'last';
  return null;
};

/** The id one step from `current` in `ids` (stopping at either end), or `null` when there is nowhere to go. */
export const stepLane = (ids: readonly string[], current: string, step: LaneStep | 'first' | 'last'): string | null => {
  if (ids.length === 0) return null;
  const at = ids.indexOf(current);
  const next =
    step === 'first' ? 0 : step === 'last' ? ids.length - 1 : Math.min(ids.length - 1, Math.max(0, at + step));
  const id = ids[next];
  return id === undefined || id === current ? null : id;
};

/** A lane on the strip: one chip. */
export interface PhoneLane {
  readonly id: string;
  readonly name: string;
  readonly count: number;
}

/** The strip's lanes for one board: its lanes in order, the closed one left out while closed is hidden. */
export const phoneLanes = (group: BoardGroupOf, hideClosed: boolean): readonly PhoneLane[] => {
  const lanes = group.lanes
    .filter(lane => !(hideClosed && lane.category === 'closed'))
    .map(lane => ({ id: lane.id, name: lane.name, count: lane.cards.length }));
  return group.unplaced.length === 0
    ? lanes
    : [...lanes, { id: UNPLACED_LANE, name: 'Unplaced', count: group.unplaced.length }];
};

/** The chip for cards whose lane the board does not know. */
export const UNPLACED_LANE = '~unplaced';

/**
 * The lane the strip shows. The one the URL names when the board still has it, else the first lane
 * holding a card (so the page opens on something), else the first lane.
 */
export const shownLane = (lanes: readonly PhoneLane[], wanted: string | null): PhoneLane | null => {
  const named = lanes.find(lane => lane.id === wanted);
  return named ?? lanes.find(lane => lane.count > 0) ?? lanes[0] ?? null;
};

/** What the Board tab's badge counts: the cards the owner is the next move on. */
export const boardBadgeCount = (counts: Pick<BoardCounts, 'toTest' | 'waitingOnYou'>): number =>
  counts.toTest + counts.waitingOnYou;
