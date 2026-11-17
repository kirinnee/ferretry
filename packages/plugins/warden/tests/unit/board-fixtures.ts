import type { Task, TaskView } from '@ferretry/plugin-board/contract';
import type { Instant } from '@ferretry/std';
import type { WardenBoardRead } from '../../daemon/lib/index.ts';
import { task, lanes, PROJECT } from '../support/board.ts';

/** The `pr-release-verify` lanes, on the one project these tasks live on. */
const LANE_SETS = new Map([[PROJECT, lanes(PROJECT)]]);

/** A task as the board derives it: `F1` by `lead`, in Implement, idle, unless told otherwise. */
export const taskView = (stored: Partial<Task> = {}, derived: Partial<TaskView> = {}): TaskView => ({
  ...task({ laneId: 'implement', ...stored }),
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

/** A task the board calls orphaned: `F1` owned by `lead`, assigned to `worker`, last touched at `touched`. */
export const orphanView = (stored: Partial<Task> = {}, touched = '2026-07-31T11:00:00.000Z'): TaskView =>
  taskView({ assignee: 'worker', ...stored }, { activity: 'orphaned', lastTouchedAt: touched as Instant });

export const boardOf = (...views: TaskView[]): WardenBoardRead => ({ views, laneSets: LANE_SETS });
