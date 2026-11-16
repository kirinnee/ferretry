import type { Card, CardView } from '@ferretry/plugin-board/contract';
import type { Instant } from '@ferretry/std';
import type { WardenBoardRead } from '../../daemon/lib/index.ts';
import { card, lanes, PROJECT } from '../support/board.ts';

/** The `pr-release-verify` lanes, on the one project these cards live on. */
const LANE_SETS = new Map([[PROJECT, lanes(PROJECT)]]);

/** A card as the board derives it: `F1` by `lead`, in Implement, idle, unless told otherwise. */
export const cardView = (stored: Partial<Card> = {}, derived: Partial<CardView> = {}): CardView => ({
  ...card({ laneId: 'implement', ...stored }),
  lastTouchedAt: null,
  touchedBy: null,
  activity: 'idle',
  rollup: {
    children: 0,
    byCategory: { backlog: 0, active: 0, review: 0, shipped: 0, verify: 0, closed: 0 },
    active: 0,
    lastTouchedAt: null,
  },
  suggestedLane: null,
  openAsks: [],
  blockedBy: [],
  blocks: [],
  shippedIn: null,
  ...derived,
});

/** A card the board calls orphaned: `F1` owned by `lead`, assigned to `worker`, last touched at `touched`. */
export const orphanView = (stored: Partial<Card> = {}, touched = '2026-07-31T11:00:00.000Z'): CardView =>
  cardView({ assignee: 'worker', ...stored }, { activity: 'orphaned', lastTouchedAt: touched as Instant });

export const boardOf = (...views: CardView[]): WardenBoardRead => ({ views, laneSets: LANE_SETS });
