/**
 * THE CARDS ONE FERRET'S CHAT READS: its ferret-scoped slice of the board, shaped for the `&` menu, the
 * chat search, and the `&F12` proof.
 *
 * One board read (`ferret = <session>`, `state = all`) through the U10 store serves all four, so nothing
 * here asks the daemon for a card by reference. A card an old session owned before the import carries
 * `legacyRef = <session>:<old id>`; `legacyIds` is the map from that old id to the card that replaced it.
 */

import type { BoardTaskView } from '@ferretry/protocol';
import type { BoardModel } from './board-model.ts';
import { cardPlaces } from './board-view.ts';
import type { DaemonId } from './daemon-connection.ts';

/** What a chat shows and proves about one card. */
export interface SessionCard {
  readonly id: string;
  readonly title: string;
  /** The card face's one line, searched with the title. */
  readonly summary: string;
  /** The lane's name on the card's own board. */
  readonly lane: string;
  /** In a closed lane, or dropped: hidden from the `&` menu until its id is typed. */
  readonly closed: boolean;
  /** In an active or review lane. */
  readonly active: boolean;
  readonly assignee: string | null;
  /** The latest real activity, or the creation instant for a card never touched. */
  readonly touchedAt: string;
  /** The id this card had as an old task of this session, when it was imported from one. */
  readonly legacyId: string | null;
}

/** The old id a card was imported under, when it was imported from a task of `sessionId`. */
const legacyIdOf = (task: BoardTaskView, sessionId: string): string | null => {
  const ref = task.legacyRef;
  if (ref === undefined) return null;
  const at = ref.indexOf(':');
  return ref.slice(0, at) === sessionId ? ref.slice(at + 1) : null;
};

/** The cards of `model` this ferret owns or is assigned, on `daemonId`, newest activity first. */
export const sessionCards = (model: BoardModel, daemonId: DaemonId, sessionId: string): readonly SessionCard[] => {
  const places = cardPlaces(model);
  return model.cards
    .filter(card => card.daemonId === daemonId)
    .filter(card => card.task.owner === sessionId || card.task.assignee === sessionId)
    .map(card => {
      const category = places.get(card.key)?.category ?? null;
      const task = card.task;
      return {
        id: task.id,
        title: task.title,
        summary: task.summary,
        lane: places.get(card.key)?.laneName ?? task.laneId,
        closed: task.dropped !== null || category === 'closed',
        active: category === 'active' || category === 'review',
        assignee: task.assignee,
        touchedAt: task.lastTouchedAt ?? task.createdAt,
        legacyId: legacyIdOf(task, sessionId),
      };
    });
};

/** The card an old reference means, or `null`: a card id on this slice wins, then an imported task's old id. */
export const resolveCardReference = (
  cards: readonly { readonly id: string; readonly legacyId?: string | null }[],
  written: string,
): string | null => {
  const wanted = written.toUpperCase();
  const own = cards.find(card => card.id.toUpperCase() === wanted);
  if (own !== undefined) return own.id;
  return cards.find(card => card.legacyId?.toUpperCase() === wanted)?.id ?? null;
};
