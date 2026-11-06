import type { BoardTask } from '@ferretry/protocol';
import { type LaneSets, cardCategory } from '../../board/graph.ts';

/**
 * The sessions that own, or are assigned, a card still in flight: not dropped, and not in a closed or shipped lane.
 *
 * A card whose lane cannot be read — a board with no lane set, a lane that no longer exists — counts as in flight:
 * when unsure, keep it. The board derives a card's presence from the roster (`presenceOf`: not held reads as dead),
 * and a lead walk goes through the roster's `lead` links, so a session still on a card must stay in the roster for
 * the board to keep seeing the same chain it saw before the archive existed.
 */
export function sessionsOnOpenCards(cards: readonly BoardTask[], laneSets: LaneSets): ReadonlySet<string> {
  const sessions = new Set<string>();
  for (const card of cards) {
    if (card.dropped !== null) continue;
    const category = cardCategory(card, laneSets);
    if (category === 'closed' || category === 'shipped') continue;
    sessions.add(card.owner);
    if (card.assignee !== null) sessions.add(card.assignee);
  }
  return sessions;
}
