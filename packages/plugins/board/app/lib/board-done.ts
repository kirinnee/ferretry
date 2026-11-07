/**
 * "DONE ✓" AND "REOPEN": the owner's two one-tap answers about a card, as a decision before anything is drawn.
 *
 * Done closes the card (the owner's close, which the daemon records in the card's history and tells the card's
 * ferret about). Reopen sends a closed card back to the last active lane and asks for a reason, because that is a
 * move backward. Both are the OWNER's, and both are asked for in the AGENDA (the Inbox's cards to try, the card ask):
 * the Board's cards draw no owner buttons.
 */

import type { LaneCategory, LaneSet } from './rules/index.ts';

type DoneLanes = Pick<LaneSet, 'lanes'>;

/**
 * A lane set that may DECLARE where Done and Not good go. A daemon with declared lanes sends `doneLane` and
 * `notGoodLane`; an older one sends neither, and the board falls back to the project's Closed lane and its
 * last active lane. Read structurally, so the same code reads both.
 */
export type DeclaredLanes = DoneLanes & {
  readonly doneLane?: LaneSet['doneLane'] | null | undefined;
  readonly notGoodLane?: LaneSet['notGoodLane'] | null | undefined;
};

const declared = (laneSet: DeclaredLanes, laneId: string | null | undefined, category: LaneCategory) =>
  laneSet.lanes.find(lane => lane.id === laneId && lane.category === category)?.id;

/** Where Done closes a card: the declared Done lane, else the project's (first) Closed lane. */
export const doneLaneOf = (laneSet: DeclaredLanes | null): string | null => {
  if (laneSet === null) return null;
  return (
    declared(laneSet, laneSet.doneLane, 'closed') ?? laneSet.lanes.find(lane => lane.category === 'closed')?.id ?? null
  );
};

/** Where Not good (and a Reopen) sends a card back: the declared lane, else the project's last active lane. */
export const notGoodLaneOf = (laneSet: DeclaredLanes | null): string | null => {
  if (laneSet === null) return null;
  return (
    declared(laneSet, laneSet.notGoodLane, 'active') ??
    laneSet.lanes.filter(lane => lane.category === 'active').at(-1)?.id ??
    null
  );
};

/**
 * THE OWNER'S ANSWER IN FLIGHT ON ONE CARD. The pressed control turns its icon into a spinner (the label stays,
 * so nothing moves under the next tap) and every answer on the card is disabled until the move settles; a
 * refusal is said on the card. `null` pressed and `null` error is a card at rest.
 */
export type BoardAnswer = 'done' | 'not-good' | 'send-back' | 'move';

export interface BoardAnswerState {
  /** The control whose move is in flight; every answer on the card is disabled while it is not `null`. */
  readonly pressed: BoardAnswer | null;
  /** Why the last move of this card did not go through. */
  readonly error: string | null;
}

export const ANSWER_AT_REST: BoardAnswerState = { pressed: null, error: null };

export type BoardDone =
  /** Close the card: move it to the project's Closed lane. */
  | { readonly kind: 'done'; readonly laneId: string }
  /** Send a closed card back for more work: the move needs a reason. */
  | { readonly kind: 'reopen'; readonly laneId: string };

export interface DoneInput {
  readonly laneSet: DeclaredLanes | null;
  /** The category of the lane the card is in, `null` when the card sits in a lane the set does not have. */
  readonly category: LaneCategory | null;
  readonly dropped: boolean;
}

/**
 * What the owner may do to this card in one tap, or `null` for nothing: no lanes, a dropped card (terminal), a
 * project with no Closed lane to close into, or a card in no known lane.
 */
export const boardDone = ({ laneSet, category, dropped }: DoneInput): BoardDone | null => {
  if (laneSet === null || dropped || category === null) return null;
  if (category === 'closed') {
    const target = notGoodLaneOf(laneSet) ?? laneSet.lanes.find(lane => lane.category !== 'closed')?.id;
    return target === undefined ? null : { kind: 'reopen', laneId: target };
  }
  const closed = doneLaneOf(laneSet);
  return closed === null ? null : { kind: 'done', laneId: closed };
};
