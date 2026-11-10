import {
  type ArchiveCardStanding,
  ArchiveCardStandingsSchema,
  type ArchiveKeepSource,
  type FerretId,
  FerretIdSchema,
} from '@ferretry/core-ferrets/contract';
import type { Card } from '../../contract/index.ts';
import { cardCategory, type LaneSets } from '../lib/board/index.ts';

/** What Board reads of itself to answer the archive: every card as stored, with every board's lanes (`snapshot`). */
export interface BoardCardSnapshot {
  snapshot(): Promise<{ readonly cards: readonly Card[]; readonly laneSets: LaneSets }>;
}

/**
 * A stored party as Ferrets names a ferret, or `undefined` when it is not a ferret id. Board stores a party as plain
 * text (`FerretRefSchema`); Ferrets' answer takes only ferret ids. A string that is not a ferret id can never match a
 * ferret the archive decides about, so leaving it out keeps nobody less live than before.
 */
const ferretOf = (party: string | null): FerretId | undefined => {
  if (party === null) return undefined;
  const parsed = FerretIdSchema.safeParse(party);
  return parsed.success ? parsed.data : undefined;
};

/**
 * One card as the archive's keep rule reads it: today's `sessionsOnOpenCards` read `owner`, `assignee`, `dropped` and
 * `cardCategory(card, laneSets)` of every stored card. A lane Board cannot name stays `undefined`, which the rule
 * reads as "in flight" (when unsure, keep).
 *
 * Each party is parsed as a ferret id, and one that is not is LEFT OUT, so one odd stored card never makes the whole
 * answer unreadable (Ferrets parses the whole list, and one bad owner would stop every pass). The contract needs an
 * owner on every standing: a card whose owner is not a ferret id but whose assignee is answers with the assignee as its
 * owner (the rule keeps owner and assignee alike, so nothing is lost); a card with neither names no ferret and is left
 * out (`undefined`).
 */
const cardStanding = (card: Card, laneSets: LaneSets): ArchiveCardStanding | undefined => {
  const owner = ferretOf(card.owner);
  const assignee = ferretOf(card.assignee);
  const named = owner ?? assignee;
  if (named === undefined) return undefined;
  return {
    owner: named,
    assignee: owner === undefined ? null : (assignee ?? null),
    dropped: card.dropped !== null,
    category: cardCategory(card, laneSets),
  };
};

/**
 * Board's half of `session.archive-keeps`: every card, closed and dropped included, so Ferrets' rule decides which
 * ferrets a card still in flight holds. Read afresh on every ask, never cached. A read that fails REJECTS: Ferrets reads
 * a rejection as "the board is unreadable" and keeps every ferret it was asked about (fail safe, never "archive").
 * The answer is checked against Ferrets' own `ArchiveCardStandingsSchema` before it leaves Board, so a standing Ferrets
 * would refuse is a rejection here (the same keep-live outcome), and the two halves cannot drift apart unseen.
 */
export const boardArchiveKeeps = (board: BoardCardSnapshot): ArchiveKeepSource => ({
  kind: 'board',
  cards: async () => {
    const { cards, laneSets } = await board.snapshot();
    const standings = cards.flatMap(card => {
      const standing = cardStanding(card, laneSets);
      return standing === undefined ? [] : [standing];
    });
    ArchiveCardStandingsSchema.parse(standings);
    return standings;
  },
});
