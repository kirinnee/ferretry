import { type BoardApi, MAX_BOARD_PAGE } from '@ferretry/plugin-board/contract';
import type { WardenBoardPort, WardenBoardRead } from './lib/index.ts';

/**
 * The project boards as the sweep reads them, through Board's contract (an optional `uses`: Board off, no port).
 *
 * Today read every card with its derived activity and every board's lanes, and a ferret's focus card from the
 * board's focus file. 5.0's `BoardApi` gives the cards (Board derives `activity: 'orphaned'`, so the card drawn red on
 * the board and the card the Warden reports stay the same cards), but neither lane sets nor a ferret's focus:
 * - GAP(board): no lane-set read, so a lane reads as its id in the orphan wording;
 * - GAP(board): no focus read, so a ferret the Warden resumes is told no card.
 * A read that throws is the sweep's "board could not be read" (journalled, nothing reported or cleared).
 */
export function boardReader(board: BoardApi): WardenBoardPort {
  return {
    read: async (): Promise<WardenBoardRead> => ({
      views: await board.cards({ state: 'open', activity: 'orphaned', limit: MAX_BOARD_PAGE }),
      laneSets: new Map(),
    }),
    focusCard: async () => undefined,
  };
}
