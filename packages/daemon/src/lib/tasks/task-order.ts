import type { Task, TaskStatus } from '@ferretry/protocol';
import { splitTaskId } from './task-id.ts';

/**
 * Board reading order: shipped work first, then work in flight, then everything still waiting on a
 * human. Every status appears exactly once, so no two statuses can collapse into the same group.
 */
export const TASK_BOARD_ORDER: readonly TaskStatus[] = Object.freeze([
  'live',
  'done',
  'built',
  'in_progress',
  'designed',
  'researched',
  'todo',
  'blocked',
  'dropped',
]);

const STATUS_RANK: Readonly<Record<TaskStatus, number>> = Object.freeze(
  Object.fromEntries(TASK_BOARD_ORDER.map((status, index) => [status, index])) as Record<TaskStatus, number>,
);

/** Codepoint comparison. `localeCompare` consults the host's ICU data, so it is not a stable key. */
const compareCodepoints = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A **total** board order: status group, then an explicit rank (a ranked task always precedes an
 * unranked one), then the identifier's ordinal, then the identifier itself.
 *
 * Totality is the point. kteam's comparator broke its final tie with `localeCompare`, which is
 * locale-sensitive — two hosts could legitimately disagree about the order of the same board, and a
 * task could appear to move between two reads that changed nothing.
 */
export const compareTasks = (a: Task, b: Task): number => {
  const group = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (group !== 0) return group;
  const aOrder = a.order ?? Number.POSITIVE_INFINITY;
  const bOrder = b.order ?? Number.POSITIVE_INFINITY;
  if (aOrder !== bOrder) return aOrder - bOrder;
  const aNumber = splitTaskId(a.id)?.number ?? 0;
  const bNumber = splitTaskId(b.id)?.number ?? 0;
  if (aNumber !== bNumber) return aNumber - bNumber;
  return compareCodepoints(a.id, b.id);
};

/** Sorts a copy; the caller's array is never reordered in place. */
export const sortTasks = (tasks: readonly Task[]): readonly Task[] => [...tasks].sort(compareTasks);
