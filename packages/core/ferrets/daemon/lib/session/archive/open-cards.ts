import type { OpenCardStanding } from '../peers/board.ts';

/**
 * The sessions that own, or are assigned, a card still in flight: not dropped, and not in a closed or shipped lane.
 *
 * A card whose lane cannot be read — a board with no lane set, a lane that no longer exists — counts as in flight:
 * when unsure, keep it. The board derives a card's presence from the roster (`presenceOf`: not held reads as dead),
 * and a lead walk goes through the roster's `lead` links, so a session still on a card must stay in the roster for
 * the board to keep seeing the same chain it saw before the archive existed.
 *
 * Each card arrives with its lane's category already resolved by Board (today's `cardCategory(card, laneSets)`;
 * `undefined` when the lane could not be read), because Ferrets cannot import Board's lane graph. UNWIRED: nothing
 * hands the archive these cards yet, and an archive without them keeps every session (`keeps.ts`: board unreadable).
 */
export function sessionsOnOpenCards(cards: readonly OpenCardStanding[]): ReadonlySet<string> {
  const sessions = new Set<string>();
  for (const card of cards) {
    if (card.dropped !== null) continue;
    const category = card.category;
    if (category === 'closed' || category === 'shipped') continue;
    sessions.add(card.owner);
    if (card.assignee !== null) sessions.add(card.assignee);
  }
  return sessions;
}
