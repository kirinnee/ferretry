import type { BoardApi, LaneSet } from '@ferretry/plugin-board/contract';
import type { WardenBoardPort, WardenBoardRead } from './lib/index.ts';

/** What the reader needs beyond Board's contract: whether a ferret was started by another ferret (a helper). */
export interface BoardReaderFacts {
  readonly isHelper: (ferret: string) => Promise<boolean>;
}

/**
 * The project boards as the sweep reads them, through Board's contract (an optional `uses`: Board off, no port).
 *
 * Today read ONE snapshot of the board (`sweepBoard`: every card with its derived activity, every board's lanes).
 * Board's `orphanedCards` gives the same single snapshot narrowed to the open orphaned cards (Board derives
 * `activity: 'orphaned'`, so the card drawn red on the board and the card the Warden reports stay the same cards), and
 * the lanes that name them. It is read ONCE and never paged: a page-by-page read judges each page against a fresh
 * board, so a card that is picked up or becomes orphaned between two pages would be skipped or told twice. `focusOf`
 * is the card a resumed ferret carries on with, with the lanes of its own board. A read that throws is the sweep's
 * "board could not be read" (journalled, nothing reported or cleared).
 */
export function boardReader(board: BoardApi, facts: BoardReaderFacts): WardenBoardPort {
  return {
    read: async (): Promise<WardenBoardRead> => {
      const { cards, laneSets } = await board.orphanedCards();
      return { views: cards, laneSets: new Map(laneSets.map((laneSet: LaneSet) => [laneSet.projectId, laneSet])) };
    },
    focusCard: async sessionId => {
      const focus = await board.focusOf(sessionId as Parameters<BoardApi['focusOf']>[0]);
      if (focus === undefined) return undefined;
      return {
        task: focus.card,
        laneSet: focus.laneSet,
        ...((await facts.isHelper(sessionId)) ? { subFerret: true } : {}),
      };
    },
  };
}
