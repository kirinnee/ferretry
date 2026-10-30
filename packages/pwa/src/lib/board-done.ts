/**
 * "DONE ✓" AND "REOPEN": the owner's two one-tap answers about a card, as a decision before anything is drawn.
 *
 * Done closes the card (the owner's close, through the same move as "Works → Close", which the daemon records
 * in the card's history and tells the card's ferret about). Reopen sends a closed card back to the last active
 * lane and asks for a reason, because that is a move backward. Both are the OWNER's: a view that is not the
 * owner's (a ferret's own chat scope) simply never asks for one.
 */

import type { LaneCategory, LaneSet } from '@ferretry/protocol';

type DoneLanes = Pick<LaneSet, 'lanes'>;

export type BoardDone =
  /** Close the card: move it to the project's Closed lane. */
  | { readonly kind: 'done'; readonly laneId: string }
  /** Send a closed card back for more work: the move needs a reason. */
  | { readonly kind: 'reopen'; readonly laneId: string };

export interface DoneInput {
  readonly laneSet: DoneLanes | null;
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
    const active = laneSet.lanes.filter(lane => lane.category === 'active');
    const target = active[active.length - 1] ?? laneSet.lanes.find(lane => lane.category !== 'closed');
    return target === undefined ? null : { kind: 'reopen', laneId: target.id };
  }
  const closed = laneSet.lanes.find(lane => lane.category === 'closed');
  return closed === undefined ? null : { kind: 'done', laneId: closed.id };
};

/** The words on the control: short on a row, spelled out where it is the card's main action. */
export const doneLabel = (done: BoardDone, spelledOut = false): string =>
  done.kind === 'reopen' ? 'Reopen' : spelledOut ? 'Mark done' : 'Done';

/** The sentence behind the control, for a tooltip and a screen reader. */
export const doneTitle = (done: BoardDone, cardTitle: string): string =>
  done.kind === 'reopen' ? `Reopen ${cardTitle}: send it back, with a reason` : `Mark ${cardTitle} done and close it`;

/**
 * Whether this lane is where released work waits to be tried: the open lane a release enters
 * (`release.published`: Released · to test, or a classic Released), else the last of the set's shipped lanes
 * (Merged is earlier).
 */
export const isReleaseLane = (laneSet: DoneLanes | null, laneId: string): boolean => {
  const lanes = laneSet?.lanes ?? [];
  const release =
    lanes.find(lane => lane.category !== 'closed' && lane.enterOn?.includes('release.published') === true) ??
    lanes.filter(lane => lane.category === 'shipped').at(-1);
  return release !== undefined && release.id === laneId;
};
