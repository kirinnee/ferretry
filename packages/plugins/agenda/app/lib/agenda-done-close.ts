/**
 * "DONE · CLOSES &F12": one owner tap that closes the cards an agenda item is linked to AND resolves the item.
 *
 * The close is the board's own Done, so the daemon records it in the card's history and tells the card's ferret, exactly as
 * the board's button does. Which lane it goes into and the one request that moves it are Board's (its
 * `agenda.card-answer` hook), so the host hands the item view a {@link DoneCloseSource} and this half imports nothing
 * of Board's, offering no Done · closes without one. The ORDER is the point: every card is closed first, and only
 * when all of them are does the item resolve. A card that will not close stops the run and leaves the item open, with
 * the reason, so the owner never believes work is closed that is not.
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
