/**
 * THE CHAT TASK PANEL'S CARD STACK: the cards this ferret holds that are waiting on the owner's answer, and only those.
 *
 * A card is in the stack while it sits in a gate lane a person asked for (`awaitingOwner`): to try (Done / Not good),
 * or to approve before the building starts. Every other card — todo, in progress, in review, merged, closed, dropped,
 * an agent's own — is not "waiting on you" and stays on the Kanban and the List. The order the Kanban and List use is
 * kept within a rank, so the same cards are in the stack as in the other two views.
 */

import { awaitingOwner } from './awaiting-owner.ts';
import { type ChatCards, chatDrawn } from './board-chat.ts';
import type { BoardCardOf, BoardCardPlace } from './board-view.ts';
import { isSnoozed, type ToTestCard, toTestOf } from './to-test-inbox.ts';

export type StackRank = 'to-test' | 'approve';

export interface StackCard {
  readonly card: BoardCardOf;
  readonly place: BoardCardPlace | undefined;
  readonly rank: StackRank;
  /** The card as the shared answer row draws it; `null` for a card to approve. */
  readonly toTest: ToTestCard | null;
}

const RANKS: readonly StackRank[] = ['to-test', 'approve'];

const entryOf = (card: BoardCardOf, place: BoardCardPlace | undefined, now: number): StackCard | null => {
  const stage = place === undefined ? null : awaitingOwner(card, place.group.laneSet);
  if (place === undefined || stage === null) return null;
  if (stage === 'approve') return { card, place, rank: 'approve', toTest: null };
  const row = toTestOf(card, place.group);
  // A snoozed card is put aside: it is not waiting for a try until its time is up.
  if (row === null || isSnoozed(row, now)) return null;
  return { card, place, rank: 'to-test', toTest: row };
};

export const cardStack = (cards: ChatCards, now: number): readonly StackCard[] => {
  const entries = chatDrawn(cards).flatMap(card => entryOf(card, cards.places.get(card.key), now) ?? []);
  return RANKS.flatMap(rank => entries.filter(entry => entry.rank === rank));
};
