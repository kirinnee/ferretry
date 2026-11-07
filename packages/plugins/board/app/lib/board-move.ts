/**
 * MOVING A CARD, AS DECISIONS: what an owner's answer on the agenda does before anything is sent.
 *
 * The owner may move any card in any direction (`board-design.md` §2.9). Forward needs no words; a move
 * BACK needs a one-line reason, so the page opens its reason box instead of sending. A move into a Closed
 * lane is "✓ Done" and goes straight through. The rule itself is the protocol's
 * (`isBackwardMove`); this file only turns it into the page's three outcomes.
 */

import { isBackwardMove, type LaneSet } from './rules/index.ts';

export type MovePlan =
  /** Already in that lane. */
  | { readonly kind: 'stay' }
  /** Send it now; `closing` is the one-tap "Done". */
  | { readonly kind: 'send'; readonly to: string; readonly closing: boolean }
  /** Ask the owner why, then send. */
  | { readonly kind: 'ask-reason'; readonly to: string }
  /** The lanes are not the project's own, or the project has none. */
  | { readonly kind: 'refused'; readonly message: string };

type MoveLanes = Pick<LaneSet, 'lanes' | 'variants'>;

export const planMove = (laneSet: MoveLanes | null, from: string, to: string): MovePlan => {
  if (from === to) return { kind: 'stay' };
  if (laneSet === null) return { kind: 'refused', message: 'This project has no confirmed lanes to move between.' };
  const backward = isBackwardMove(laneSet, from, to);
  if (!backward.ok) {
    const lane = backward.error.code === 'unknown-lane' ? backward.error.laneId : to;
    return { kind: 'refused', message: `Lane ${lane} is not on this project's board.` };
  }
  if (backward.value) return { kind: 'ask-reason', to };
  const category = laneSet.lanes.find(lane => lane.id === to)?.category;
  return { kind: 'send', to, closing: category === 'closed' };
};
