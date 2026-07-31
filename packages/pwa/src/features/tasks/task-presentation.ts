/**
 * Task presentation vocabulary — the pure half of the task surfaces.
 *
 * Ported from kteam `ui/src/lib/tasks.ts` (the `*_META` / `*_COPY` tables) and
 * `ui/src/lib/task-views.ts` (the filter projections). Only the presentation
 * facts came across: the record schema itself now lives in `@ferretry/protocol`,
 * so this module never re-parses a task and never re-declares its shape.
 *
 * STATUS IS THE COLOUR SPINE. A task board exists to show one fact — status —
 * so every row, lane header, filter chip and detail summary re-encodes the
 * SAME status tone. The tone names here are the contrast-checked theme roles
 * (`ok`/`warn`/`err`/`pend`/`accent`), never literal colours, which is what
 * lets all ten theme families inherit the treatment with no rules of their own.
 */

import type { TaskPhase, TaskStaleness, TaskStatus, TaskSummary } from '@ferretry/protocol';

/** The five contrast-checked state roles shared with `.kt-badge`. */
export type TaskTone = 'ok' | 'warn' | 'err' | 'pend' | 'accent';

export interface TaskStateMeta {
  readonly label: string;
  readonly tone: TaskTone;
}

export const TASK_STATUS_META: Readonly<Record<TaskStatus, TaskStateMeta>> = {
  todo: { label: 'To do', tone: 'pend' },
  researched: { label: 'Researched', tone: 'warn' },
  designed: { label: 'Designed', tone: 'accent' },
  in_progress: { label: 'In progress', tone: 'warn' },
  built: { label: 'Built', tone: 'accent' },
  live: { label: 'Live', tone: 'ok' },
  done: { label: 'Done', tone: 'ok' },
  blocked: { label: 'Blocked', tone: 'err' },
  dropped: { label: 'Dropped', tone: 'err' },
};

export const TASK_PHASE_META: Readonly<Record<TaskPhase, TaskStateMeta>> = {
  todo: { label: 'To do', tone: 'pend' },
  research: { label: 'Research', tone: 'warn' },
  design: { label: 'Design', tone: 'accent' },
  build: { label: 'Build', tone: 'warn' },
  built: { label: 'Built', tone: 'accent' },
  live: { label: 'Live', tone: 'ok' },
  done: { label: 'Done', tone: 'ok' },
  dropped: { label: 'Dropped', tone: 'err' },
};

/**
 * Staleness is EVIDENCE, never a verdict. Each reason says what was observed
 * and states plainly that the declared status has not been changed — the copy
 * is load-bearing, because a board that quietly "corrects" a status is a board
 * whose statuses cannot be trusted.
 */
export const TASK_STALENESS_COPY: Readonly<Record<TaskStaleness, { readonly label: string; readonly reason: string }>> =
  {
    'assignee-dead': {
      label: 'Assignee unavailable',
      reason:
        'Declared status remains in progress; the assignee is no longer live. Verify and update the declared status manually.',
    },
    'maybe-finished': {
      label: 'Maybe finished',
      reason:
        'The assignee reports completion or has a done marker. This is evidence only; verify before changing the declared status.',
    },
    quiet: {
      label: 'Quiet',
      reason: 'No recent task or assignee activity was observed. The declared status has not been changed.',
    },
  };

/**
 * Board display order. Derived from the meta table's own key order rather than
 * repeated as a second literal, so a status added to the protocol fails the
 * exhaustive `Record` above instead of silently vanishing from every filter.
 */
export const TASK_STATUS_ORDER: readonly TaskStatus[] = Object.keys(TASK_STATUS_META) as TaskStatus[];

/** `null` is the explicit All state, matching the lineage filter vocabulary. */
export const toggleTaskStatusFilter = (
  current: ReadonlySet<TaskStatus> | null,
  status: TaskStatus,
): ReadonlySet<TaskStatus> | null => {
  if (current === null) return new Set([status]);
  const next = new Set(current);
  if (next.has(status)) next.delete(status);
  else next.add(status);
  return next.size === 0 ? null : next;
};

export const taskStatusCounts = (tasks: readonly TaskSummary[]): ReadonlyMap<TaskStatus, number> => {
  const counts = new Map<TaskStatus, number>();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  return counts;
};

/** Keeps selected zero-count statuses mounted so a filter can always be removed. */
export const orderedTaskStatuses = (
  counts: ReadonlyMap<TaskStatus, number>,
  selected: ReadonlySet<TaskStatus> | null,
): TaskStatus[] => {
  const visible = new Set(counts.keys());
  if (selected) for (const status of selected) visible.add(status);
  return TASK_STATUS_ORDER.filter(status => visible.has(status));
};

export const filterTasksByStatuses = (
  tasks: readonly TaskSummary[],
  statuses: ReadonlySet<TaskStatus> | null,
): TaskSummary[] => (statuses === null ? [...tasks] : tasks.filter(task => statuses.has(task.status)));

export const taskFilterSummary = (matchCount: number, contextCount: number): string =>
  `${matchCount} ${matchCount === 1 ? 'match' : 'matches'} · ${contextCount} ${contextCount === 1 ? 'path' : 'paths'}`;

/** A visual preview only; callers must expose the unchanged title in `title`/ARIA. */
export const taskTitlePreview = (title: string, maxCharacters = 30): string => {
  if (title.length <= maxCharacters) return title;
  return `${title.slice(0, Math.max(1, maxCharacters - 1)).trimEnd()}…`;
};

/** The subset of a task an assignee identity is derived from. */
export type TaskAssigneeSource = Pick<TaskSummary, 'assignee' | 'live'>;

export interface TaskAssigneePresentation {
  readonly name: string;
  /** Non-null only when the live annotator PROVED a current session. */
  readonly sessionId: string | null;
  readonly status: string | null;
  readonly label: string;
  readonly assigned: boolean;
}

const nonBlank = (value: string | null | undefined): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/**
 * Resolves display identity WITHOUT replacing the stored historical assignee.
 *
 * Only the live annotator can prove that an assignee resolves to a current
 * session. A stored id-shaped string may be historical and must not become a
 * dead navigation route merely because it matches a naming convention.
 *
 * Note there is no `href` here, unlike kteam's version: a session path is
 * meaningless without the daemon that owns the session, and this module has no
 * business inventing one. `TaskAssigneeLink` builds the path from its own
 * daemon id.
 */
export const taskAssigneePresentation = (task: TaskAssigneeSource): TaskAssigneePresentation => {
  const stored = nonBlank(task.assignee);
  const sessionId = nonBlank(task.live.assigneeSessionId);
  const name = nonBlank(task.live.assigneeName) ?? stored ?? 'Unassigned';
  const status = task.live.staleness
    ? TASK_STALENESS_COPY[task.live.staleness].label
    : task.live.assigneeStatus
      ? task.live.assigneeStatus.replaceAll('_', ' ')
      : stored
        ? 'status unavailable'
        : null;
  return {
    name,
    sessionId,
    status,
    label: status ? `${name} · ${status}` : name,
    assigned: stored !== null,
  };
};
