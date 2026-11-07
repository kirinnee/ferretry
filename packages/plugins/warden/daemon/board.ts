import { type BoardApi, type LaneSet, MAX_BOARD_PAGE } from '@ferretry/plugin-board/contract';
import type { WardenBoardPort, WardenBoardRead } from './lib/index.ts';

/** More pages than any board has: a cursor that never ends is a broken board, not a reason to read for ever. */
const MAX_PAGES = 200;

/** What the reader needs beyond Board's contract: whether a ferret was started by another ferret (a helper). */
export interface BoardReaderFacts {
  readonly isHelper: (ferret: string) => Promise<boolean>;
}

/**
 * The project boards as the sweep reads them, through Board's contract (an optional `uses`: Board off, no port).
 *
 * Today read every card with its derived activity and every board's lanes, and a ferret's focus card from the
 * board's focus file. Board's `cardsPage` gives every orphaned card (Board derives `activity: 'orphaned'`, so the card
 * drawn red on the board and the card the Warden reports stay the same cards), read page by page so more than one
 * page of them are all flagged; `laneSets` names the lanes; `focusOf` is the card a resumed ferret carries on with.
 * A read that throws is the sweep's "board could not be read" (journalled, nothing reported or cleared): that includes
 * a read that stops half way, because a card only some pages saw must not be read as recovered.
 */
export function boardReader(board: BoardApi, facts: BoardReaderFacts): WardenBoardPort {
  const laneSetsOf = async (): Promise<ReadonlyMap<string, LaneSet>> =>
    new Map((await board.laneSets()).map(laneSet => [laneSet.projectId, laneSet]));
  return {
    read: async (): Promise<WardenBoardRead> => {
      const views = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const got = await board.cardsPage({
          state: 'open',
          activity: 'orphaned',
          limit: MAX_BOARD_PAGE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        views.push(...got.cards);
        if (got.nextCursor === null) return { views, laneSets: await laneSetsOf() };
        if (seen.has(got.nextCursor)) throw new Error('the board paged back to a cursor it had already given');
        seen.add(got.nextCursor);
        cursor = got.nextCursor;
      }
      throw new Error(`the board gave more than ${String(MAX_PAGES)} pages of orphaned cards`);
    },
    focusCard: async sessionId => {
      const card = await board.focusOf(sessionId as Parameters<BoardApi['focusOf']>[0]);
      if (card === undefined) return undefined;
      const laneSet = (await laneSetsOf()).get(card.projectId) ?? null;
      return { task: card, laneSet, ...((await facts.isHelper(sessionId)) ? { subFerret: true } : {}) };
    },
  };
}
