import type { TaskBoardLane, TaskPhase, TaskStaleness, TaskStatus } from '@ferretry/protocol';

/** Board lanes top to bottom: what has not started first, what is finished last. */
export const TASK_BOARD_LANE_ORDER: readonly TaskBoardLane[] = [
  'todo',
  'in_progress',
  'built',
  'live',
  'done',
  'dropped',
];

/** The lane headings a human reads; this is the product's vocabulary, not the wire enum. */
export const TASK_LANE_LABEL: Readonly<Record<TaskBoardLane, string>> = {
  todo: '⚪ NOT STARTED',
  in_progress: '🔵 IN PROGRESS',
  built: '🟡 BUILT',
  live: '🟢 LIVE',
  done: '✅ DONE',
  dropped: '❌ NOT POSSIBLE',
};

/** The declared status of one task, spelled out. Distinct from a lane: research/design/build share a lane. */
export const TASK_STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  todo: '⚪ NOT STARTED',
  researched: '🟠 RESEARCHED',
  designed: '🟣 DESIGNED',
  in_progress: '🔵 IN PROGRESS',
  built: '🟡 BUILT',
  live: '🟢 LIVE',
  done: '✅ DONE',
  blocked: '🟤 BLOCKED',
  dropped: '❌ NOT POSSIBLE',
};

/** What a derived staleness flag means, in the words the badge shows. Never a status. */
export const TASK_STALENESS_COPY: Readonly<Record<TaskStaleness, string>> = {
  'assignee-dead': 'assignee is not running — verify this is still moving',
  'maybe-finished': 'assignee reported finished — verify, then set the status',
  quiet: 'no activity for a while — check it has not silently stopped',
};

/**
 * Presentation-only collapse: the audit phases research/design/build share one board lane while the
 * stored phase stays exact, so history and transition gates remain honest.
 */
export function taskBoardLaneFromPhase(phase: TaskPhase): TaskBoardLane {
  return phase === 'research' || phase === 'design' || phase === 'build' ? 'in_progress' : phase;
}
