/**
 * MOVING A CARD FROM THE BOARD, AS DECISIONS: what a drop or a "Move to…" pick does before anything is sent.
 *
 * The owner may move any card in any direction (`board-design.md` §2.9). Forward needs no words; a move
 * BACK needs a one-line reason, so the page opens its reason box instead of sending. Dragging into a Closed
 * lane is "✓ Works → Close" and goes straight through. The rule itself is the protocol's
 * (`isBackwardMove`); this file only turns it into the page's three outcomes.
 */

import { isBackwardMove, type LaneCategory, type LaneSet } from '@ferretry/protocol';

export type MovePlan =
  /** Dropped where it already is. */
  | { readonly kind: 'stay' }
  /** Send it now; `closing` is the one-tap "Works → Close". */
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

export interface MoveChoice {
  readonly laneId: string;
  readonly name: string;
  readonly category: LaneCategory;
  /** A move back: choosing it asks for a reason. */
  readonly backward: boolean;
}

/** Every lane but the card's own, in lane order, with whether getting there is a move back. */
export const moveChoices = (laneSet: MoveLanes | null, from: string): readonly MoveChoice[] => {
  if (laneSet === null) return [];
  const origin = laneSet.lanes.findIndex(lane => lane.id === from);
  return laneSet.lanes.flatMap((lane, index) =>
    lane.id === from
      ? []
      : [{ laneId: lane.id, name: lane.name, category: lane.category, backward: origin >= 0 && index < origin }],
  );
};
