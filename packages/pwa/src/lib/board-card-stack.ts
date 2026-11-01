/**
 * THE CHAT TASK PANEL'S CARD STACK: the cards this ferret holds, in the order the owner should look at them.
 *
 * What needs the owner comes first: cards waiting for a try (a verify lane, with a Done and a Not good to give), then
 * cards a ferret is blocked on the owner for, then everything else. Within a rank the order the Kanban and List
 * already use is kept, so the same cards are in the stack as in the other two views.
 */

import type { BoardCardPlace, BoardCardOf } from './board-view.ts';
import { type ChatCards, chatDrawn } from './board-chat.ts';
import { isSnoozed, type ToTestCard, toTestOf } from './to-test-inbox.ts';

export type StackRank = 'to-test' | 'waiting' | 'rest';

export interface StackCard {
  readonly card: BoardCardOf;
  readonly place: BoardCardPlace | undefined;
  readonly rank: StackRank;
  /** The card as the shared answer row draws it; `null` unless the owner has a verdict to give on it. */
  readonly toTest: ToTestCard | null;
}

const RANKS: readonly StackRank[] = ['to-test', 'waiting', 'rest'];

const entryOf = (card: BoardCardOf, place: BoardCardPlace | undefined, now: number): StackCard => {
  const row = place?.category === 'verify' ? toTestOf(card, place.group) : null;
  // A snoozed card is put aside: it is not waiting for a try until its time is up.
  const toTest = row !== null && isSnoozed(row, now) ? null : row;
  if (toTest !== null) return { card, place, rank: 'to-test', toTest };
  const waiting = card.task.activity === 'waiting' && card.task.waitingOnOwner.length > 0;
  return { card, place, rank: waiting ? 'waiting' : 'rest', toTest: null };
};

export const cardStack = (cards: ChatCards, now: number): readonly StackCard[] => {
  const entries = chatDrawn(cards).map(card => entryOf(card, cards.places.get(card.key), now));
  return RANKS.flatMap(rank => entries.filter(entry => entry.rank === rank));
};
