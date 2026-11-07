/**
 * "DONE · CLOSES &F12": one owner tap that closes the cards an agenda item is linked to AND resolves the item.
 *
 * The close is the board's own Done, so the daemon records it in the card's history and tells the card's ferret,
 * exactly as the board's button does; it is Board's write, so the host that can make it hands the item view a
 * {@link DoneCloseSource} (this half imports nothing of Board's, and offers no Done · closes without one). The ORDER is the point:
 * every card is closed first, and only when all of them are does the item resolve. A card that will not close
 * stops the run and leaves the item open, with the reason, so the owner never believes work is closed that is not.
 */

import { type AgendaItem, formatTaskRef, type TaskRef } from '@ferretry/core-asks/contract';

export type DoneCloseResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** A card the tap would close; the title is absent until the board has read it. */
export interface DoneCloseCard {
  readonly ref: TaskRef;
  readonly title?: string | undefined;
}

/** What a host hands the item view: the cards on offer and the way to close some of them. */
export interface DoneCloseSource {
  readonly cards: readonly DoneCloseCard[];
  readonly close: (refs: readonly TaskRef[]) => Promise<DoneCloseResult>;
}

/** The cards an item's tap would close: only where the item asked and the card is this machine's. */
export const offeredCards = (
  item: Pick<AgendaItem, 'offerClose' | 'task' | 'notice'>,
  daemonId: string,
): readonly TaskRef[] => {
  const task = item.task;
  if (item.offerClose !== true || item.notice === true) return [];
  if (task === undefined || task === null) return [];
  return task.machineId === undefined || task.machineId === daemonId ? [task] : [];
};

/** The button's words: "Done · closes &F12", or every card it closes. */
export const doneCloseLabel = (refs: readonly TaskRef[]): string =>
  `Done · closes ${refs.map(formatTaskRef).join(', ')}`;

/**
 * The same words where the row is narrow (a phone): "Close &F12", or "Close 3 cards". The row stays ONE line with
 * "Not needed" in it (the owner's compact action area); the full words stay the button's name and its title.
 */
export const doneCloseShortLabel = (refs: readonly TaskRef[]): string =>
  refs.length === 1 && refs[0] !== undefined ? `Close ${formatTaskRef(refs[0])}` : `Close ${refs.length} cards`;

/** One lane of a card's board, as far as a Done reads it (Board's lane set, opaque to this half). */
interface LaneForClose {
  readonly id: string;
  readonly category: string;
}

/** The card as the board read it: what a Done needs. */
export interface CardForClose {
  readonly laneId: string;
  readonly dropped: boolean;
  readonly laneSet: {
    readonly lanes: readonly LaneForClose[];
    readonly doneLane?: string | null | undefined;
  } | null;
}

/**
 * The lane a Done moves the card into, `'closed'` when it already is, or why it cannot be closed. Board's own Done
 * rule, as far as a close reads it: the set's declared Done lane when it is a closing lane, else its first closing
 * lane; nothing for a dropped card, a card in a lane the set does not have, or a set with no closing lane.
 */
export const closePlan = (
  card: CardForClose | undefined,
):
  | { readonly kind: 'move'; readonly laneId: string }
  | { readonly kind: 'closed' }
  | { readonly kind: 'refused'; readonly message: string } => {
  if (card === undefined) return { kind: 'refused', message: 'the card could not be read' };
  const refused = { kind: 'refused', message: 'the board has no Done for this card' } as const;
  const laneSet = card.laneSet;
  const category = laneSet?.lanes.find(lane => lane.id === card.laneId)?.category;
  if (laneSet === null || card.dropped || category === undefined) return refused;
  // A closed card counts as done only where it could be sent back: a set with a lane to reopen it into.
  if (category === 'closed')
    return laneSet.lanes.some(lane => lane.category !== 'closed') ? { kind: 'closed' } : refused;
  const done =
    laneSet.lanes.find(lane => lane.id === laneSet.doneLane && lane.category === 'closed')?.id ??
    laneSet.lanes.find(lane => lane.category === 'closed')?.id;
  return done === undefined ? refused : { kind: 'move', laneId: done };
};

/**
 * Closes each card in turn and stops at the first that will not close. A failure names the card and, when
 * earlier ones did close, says so — they stay closed.
 */
export const closeCards = async (
  refs: readonly TaskRef[],
  close: (ref: TaskRef) => Promise<DoneCloseResult>,
): Promise<DoneCloseResult> => {
  const closed: string[] = [];
  for (const ref of refs) {
    const result = await close(ref);
    if (!result.ok) {
      const earlier = closed.length === 0 ? '' : ` (${closed.join(', ')} closed)`;
      return { ok: false, message: `${formatTaskRef(ref)}: ${result.message}${earlier}` };
    }
    closed.push(formatTaskRef(ref));
  }
  return { ok: true };
};
