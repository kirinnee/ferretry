import type { ArchiveCardStanding, ArchiveKeepSource } from '@ferretry/core-ferrets/contract';
import type { Card } from '../../contract/index.ts';
import { cardCategory, type LaneSets } from '../lib/board/index.ts';

/** What Board reads of itself to answer the archive: every card as stored, with every board's lanes (`snapshot`). */
export interface BoardCardSnapshot {
  snapshot(): Promise<{ readonly cards: readonly Card[]; readonly laneSets: LaneSets }>;
}

/**
 * One card as the archive's keep rule reads it: today's `sessionsOnOpenCards` read `owner`, `assignee`, `dropped` and
 * `cardCategory(card, laneSets)` of every stored card. A lane Board cannot name stays `undefined`, which the rule
 * reads as "in flight" (when unsure, keep).
 */
const cardStanding = (card: Card, laneSets: LaneSets): ArchiveCardStanding => ({
  owner: card.owner,
  assignee: card.assignee,
  dropped: card.dropped !== null,
  category: cardCategory(card, laneSets),
});

/**
 * Board's half of `session.archive-keeps`: every card, closed and dropped included, so Ferrets' rule decides which
 * ferrets a card still in flight holds. Read afresh on every ask, never cached. A read that fails REJECTS: Ferrets reads
 * a rejection as "the board is unreadable" and keeps every ferret it was asked about (fail safe, never "archive").
 */
export const boardArchiveKeeps = (board: BoardCardSnapshot): ArchiveKeepSource => ({
  kind: 'board',
  cards: async () => {
    const { cards, laneSets } = await board.snapshot();
    return cards.map(card => cardStanding(card, laneSets));
  },
});
