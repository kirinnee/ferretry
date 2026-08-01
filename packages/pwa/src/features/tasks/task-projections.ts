/**
 * The projection half of kteam `ui/src/lib/tasks.ts` — everything that turns a
 * flat fleet array into what a board, a list or a detail pane actually renders.
 *
 * The parsing half is NOT here and never will be: `@ferretry/protocol` owns the
 * task schema, so nothing in this file re-validates a record. The presentation
 * vocabulary (`TASK_*_META`, `TASK_STALENESS_COPY`) lives in
 * `task-presentation.ts`, and the board's own words (`taskBoardLane`,
 * `taskReference`, `TaskFileConflict`) in `task-board-model.ts`. What was left
 * over is the arithmetic, which is this file.
 *
 * ONE FLEET ARRAY, MANY VIEWS. Every function here derives from the same array
 * a single response produced. A board that kept its own copy of the fleet, or a
 * lane that filtered from a different source than the count above it, is how a
 * task appears in two columns at once — so the lane grouping, the session
 * projection and the conflict map are all pure passes over the caller's array
 * and none of them caches.
 *
 * MULTI-DAEMON. Tasks arrive per daemon, and a `TaskId` is unique only within
 * the daemon that minted it. There is deliberately NO module-level state here
 * to key by `DaemonId`: these are pure functions over an array the caller
 * already fetched through a `(daemonId, …)`-scoped client, so two daemons'
 * boards cannot share a byId map, a conflict map or a sort order — there is
 * nothing to share. `tasksForSession` takes the session id explicitly rather
 * than reading an ambient "current session" for the same reason.
 */

import type { ScopedTaskSummary, TaskActivity, TaskPhase, TaskStatus, TaskSummary } from '@ferretry/protocol';
import { type TaskFileConflict, taskBoardLane, taskReference } from './task-board-model.ts';
import { TASK_STALENESS_COPY } from './task-presentation.ts';

/**
 * Board and audit orderings, written out rather than read off a zod enum's
 * `.options`. These are RENDER orders — the sequence lanes appear in on screen —
 * and tying them to the schema's declaration order would make a harmless
 * protocol reshuffle silently rearrange the board.
 */
export const TASK_PHASE_ORDER = [
  'todo',
  'research',
  'design',
  'build',
  'built',
  'live',
  'done',
  'dropped',
] as const satisfies readonly TaskPhase[];

export const TASK_BOARD_LANE_ORDER = ['todo', 'in_progress', 'built', 'live', 'done', 'dropped'] as const;

/**
 * Who is on this task and whether they are still there.
 *
 * Staleness OUTRANKS the live status because it is the more urgent fact: a task
 * whose assignee died still reports whatever status that session last wrote,
 * and showing `running` next to a dead session is the specific lie
 * `TASK_STALENESS_COPY` exists to prevent. An assignee with no readable status
 * says so plainly rather than rendering a blank.
 */
export const taskLivenessLabel = (task: Pick<TaskSummary, 'assignee' | 'live'>): string => {
  if (!task.assignee) return 'Unassigned';
  if (task.live.staleness) return TASK_STALENESS_COPY[task.live.staleness].label;
  return task.live.assigneeStatus
    ? `${task.assignee} · ${task.live.assigneeStatus}`
    : `${task.assignee} · status unavailable`;
};

/**
 * One line of audit history, in words.
 *
 * WHAT CHANGED FROM KTEAM. Its version read an untyped `Record<string, unknown>`
 * and coped with it by trying several key spellings per field
 * (`phaseFrom ?? from`, `taskId ?? dependency`, `path ?? file`,
 * `operation === 'remove' || remove === true`). Ferretry's `TaskActivity` is a
 * discriminated union with one spelling for each field, so those fallbacks are
 * dead branches that could only ever be reached by a record the protocol would
 * have rejected. They are gone, and the switch is exhaustive instead — a new
 * activity type becomes a type error here rather than a row that silently
 * renders its own type name.
 *
 * The rendered strings are kteam's, including the `Reopened · ` / `Moved back · `
 * prefixes and the `→` between phases.
 */
export const taskActivityText = (activity: TaskActivity): string => {
  switch (activity.type) {
    case 'created':
      return `Created in ${activity.data.phase}`;
    case 'status': {
      const { data } = activity;
      const prefix = data.reopened ? 'Reopened · ' : data.backward ? 'Moved back · ' : '';
      const why = data.reason || data.note;
      return `${prefix}${data.phaseFrom} → ${data.phaseTo}${why ? `: ${why}` : ''}`;
    }
    case 'clarification':
      return `Clarification: ${activity.data.text}`;
    case 'dependency':
      return `${activity.data.operation === 'remove' ? 'Removed dependency' : 'Depends on'} ${taskReference(activity.data.taskId)}`;
    case 'file': {
      const { path, operation, reason } = activity.data;
      return `${operation === 'remove' ? 'Unclaimed file' : 'Claimed file'} ${path}${reason ? `: ${reason}` : ''}`;
    }
    case 'session':
      return activity.data.event === 'completion-claim'
        ? `Completion claim: ${activity.data.session} (turn ${activity.data.turn}, ${activity.data.phase})`
        : `Reopen acknowledged by ${activity.data.resolvedByName ?? activity.data.resolvedBy}${activity.data.note ? `: ${activity.data.note}` : ''}`;
    case 'assign':
      return `Assigned to ${activity.data.to ?? 'unassigned'}`;
    case 'order':
      return `Priority ${activity.data.from ?? 'unranked'} → ${activity.data.to ?? 'unranked'}`;
    case 'link':
      return `Linked ${activity.data.field}: ${activity.data.value}`;
    default:
      return activity.data.text;
  }
};

/** `'all'` is the explicit unfiltered state for each axis, never an empty string. */
export interface TaskFilters {
  readonly repo: string;
  readonly status: TaskStatus | 'all';
  readonly assignee: string;
}

export const filterTasks = <Task extends TaskSummary>(tasks: readonly Task[], filters: TaskFilters): Task[] =>
  tasks.filter(
    task =>
      (filters.repo === 'all' || task.repo === filters.repo) &&
      (filters.status === 'all' || task.status === filters.status) &&
      (filters.assignee === 'all' || task.assignee === filters.assignee),
  );

/**
 * An absent or unparseable timestamp sorts LAST, not first. `sortTasksForList`
 * leads with the oldest evidence, so treating "no timestamp" as time zero would
 * put every undated record at the top of the attention list ahead of real
 * blocked work.
 */
const timeOf = (value: string | null | undefined): number => {
  const parsed = value ? Date.parse(value) : Number.POSITIVE_INFINITY;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

/**
 * The attention-first list order: blocked cards, then stale ones, then the
 * rest — and within each band, the OLDEST evidence first.
 *
 * This is kteam's "ADHD list" ordering and it is deliberate. A list sorted by
 * recency asks the reader to scan for what is wrong; this one puts what is
 * wrong at the top and puts the thing that has been wrong longest above the
 * thing that broke a minute ago. Ties fall through to explicit priority, then
 * to id, so the order is total and a re-read never reshuffles equal rows.
 */
export const sortTasksForList = <Task extends TaskSummary>(tasks: readonly Task[]): Task[] => {
  const attention = (task: Task): number => (task.blocked ? 0 : task.live.staleness ? 1 : 2);
  return [...tasks].sort((left, right) => {
    const band = attention(left) - attention(right);
    if (band !== 0) return band;
    // Two undated records both read as +Infinity, so their difference is NaN.
    // NaN from a comparator is an UNORDERED result, not a tie, and leaves the
    // sort implementation-defined — so it falls through to the next key
    // deliberately, while a real ±Infinity (dated vs undated) still decides.
    const at =
      timeOf(left.blockedSince ?? left.updatedAt ?? left.createdAt) -
      timeOf(right.blockedSince ?? right.updatedAt ?? right.createdAt);
    if (at !== 0 && !Number.isNaN(at)) return at;
    const order = (left.order ?? Number.POSITIVE_INFINITY) - (right.order ?? Number.POSITIVE_INFINITY);
    return order || left.id.localeCompare(right.id);
  });
};

export interface TaskBoardLaneGroup<Task extends TaskSummary = TaskSummary> {
  readonly lane: (typeof TASK_BOARD_LANE_ORDER)[number];
  readonly tasks: readonly Task[];
}

export interface TaskPhaseGroup<Task extends TaskSummary = TaskSummary> {
  readonly phase: TaskPhase;
  readonly tasks: readonly Task[];
}

/**
 * Every lane, including the empty ones. A board that dropped its empty columns
 * would reflow as work moved, so a card the reader was aiming at slides out
 * from under the pointer — and "nothing is in Built" is itself a fact worth
 * showing.
 */
export const groupTasksByBoardLane = <Task extends TaskSummary>(
  tasks: readonly Task[],
): Array<TaskBoardLaneGroup<Task>> =>
  TASK_BOARD_LANE_ORDER.map(lane => ({
    lane,
    tasks: sortTasksForList(tasks.filter(task => taskBoardLane(task.phase) === lane)),
  }));

/** The raw audit-phase projection, for consumers that must not see the collapse. */
export const groupTasksByPhase = <Task extends TaskSummary>(tasks: readonly Task[]): Array<TaskPhaseGroup<Task>> =>
  TASK_PHASE_ORDER.map(phase => ({ phase, tasks: sortTasksForList(tasks.filter(task => task.phase === phase)) }));

/**
 * The rows one session owns, derived from the single fleet array so a session
 * surface can never show another session's work.
 *
 * Takes `ScopedTaskSummary` because only a scoped record carries `sessionId` at
 * all: an unscoped `TaskSummary` came from a session-addressed response and has
 * no session field to compare, which is exactly the confusion this signature
 * refuses to allow.
 */
export const tasksForSession = <Task extends ScopedTaskSummary>(fleet: readonly Task[], sessionId: string): Task[] =>
  fleet.filter(task => task.sessionId === sessionId);

/**
 * Phases in which a file claim is still a live claim.
 *
 * A claim is an early warning about concurrent work. Once a task is built, live,
 * done or dropped, its historical claim must not keep a conflict banner lit on
 * work that is actually active — the banner would then be permanent, and a
 * permanent warning is one nobody reads.
 */
const ACTIVE_FILE_CLAIM_PHASES: ReadonlySet<TaskPhase> = new Set<TaskPhase>(['todo', 'research', 'design', 'build']);

/**
 * Which other tasks claim a file this task also claims — advisory visibility,
 * never a lock, an edge or a blocker.
 *
 * Two tasks conflict only when the exact path matches AND their repos do not
 * PROVABLY differ (equal, or either side unknown). An identical relative path
 * in two known-different repos is not the same file, and calling it one would
 * train readers to dismiss the banner.
 */
export const computeFileConflicts = (
  fleet: readonly ScopedTaskSummary[],
): ReadonlyMap<string, readonly TaskFileConflict[]> => {
  const active = fleet.filter(task => ACTIVE_FILE_CLAIM_PHASES.has(task.phase) && task.files.length > 0);
  const result = new Map<string, readonly TaskFileConflict[]>();
  for (const task of active) {
    const claimed = new Set(task.files);
    const conflicts: TaskFileConflict[] = [];
    for (const other of active) {
      if (other.id === task.id) continue;
      if (task.repo && other.repo && task.repo !== other.repo) continue;
      const overlap = [...new Set(other.files)].filter(file => claimed.has(file)).sort();
      if (overlap.length === 0) continue;
      conflicts.push({
        taskId: other.id,
        sessionId: other.sessionId,
        files: overlap,
        crossSession: other.sessionId !== task.sessionId,
      });
    }
    if (conflicts.length > 0) {
      result.set(
        task.id,
        conflicts.sort((left, right) => left.taskId.localeCompare(right.taskId)),
      );
    }
  }
  return result;
};
