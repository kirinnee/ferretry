/**
 * The board vocabulary a task row and a task summary are rendered from.
 *
 * Ported from kteam `ui/src/lib/tasks.ts` (lane meta, workflow labels, the
 * reference sigil) and the pure helpers at the top of
 * `ui/src/components/TaskPresentation.tsx`.
 */

import type { TaskBoardLane, TaskPhase, TaskSummary, TaskWorkflow } from '@ferretry/protocol';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { formatReference } from '../../lib/references.ts';
import { TASK_STATUS_META, type TaskStateMeta } from './task-presentation.ts';

/**
 * A BOARD has six columns; a task has eight phases. Research, design and build
 * are all "someone is working on it" as far as a column is concerned, so they
 * collapse into one lane and the exact phase survives as audit detail.
 */
export const TASK_BOARD_LANE_META: Readonly<Record<TaskBoardLane, TaskStateMeta>> = {
  todo: { label: 'To do', tone: 'pend' },
  in_progress: { label: 'In progress', tone: 'warn' },
  built: { label: 'Built', tone: 'accent' },
  live: { label: 'Live', tone: 'ok' },
  done: { label: 'Done', tone: 'ok' },
  dropped: { label: 'Dropped', tone: 'err' },
};

export const TASK_WORKFLOW_LABEL: Readonly<Record<TaskWorkflow, string>> = {
  quick: 'Quick',
  'design-first': 'Design first',
  'research-first': 'Research first',
  investigate: 'Investigate',
};

export const taskBoardLane = (phase: TaskPhase): TaskBoardLane =>
  phase === 'research' || phase === 'design' || phase === 'build' ? 'in_progress' : phase;

const unprefixedTaskId = (id: string): string => id.replace(/^[#&]/u, '');
const inertTaskLabel = (value: string): string => value.replaceAll('&', '');

/** All local human-facing task references use the canonical formatter. */
export const taskReference = (id: string): string => {
  const taskId = unprefixedTaskId(id);
  try {
    return formatReference({ kind: 'task', id: taskId });
  } catch {
    // Activity history can retain an id from damaged/older data. Keep the label
    // renderable but inert: inventing a sigil token would address another task.
    return inertTaskLabel(taskId);
  }
};

/**
 * Spell a row's task relative to the session whose composer/transcript reads it.
 * A current-session row stays bare; a foreign row names its exact owner.
 */
export const taskReferenceFor = (
  viewerScope: Pick<DaemonSessionScope, 'sessionId'>,
  ownerSessionId: string,
  id: string,
): string => {
  const taskId = unprefixedTaskId(id);
  try {
    return formatReference({
      kind: 'task',
      id: taskId,
      ...(ownerSessionId === viewerScope.sessionId ? {} : { sessionId: ownerSessionId }),
    });
  } catch {
    // Never fall back to a bare token for a foreign/unsafe owner: that would
    // silently point at the viewer's task. Unqualified text is the fail-closed UI.
    return inertTaskLabel(taskId);
  }
};

/** The state a row wears: blocked outranks whichever phase it is blocked in. */
export const taskBoardState = (task: Pick<TaskSummary, 'blocked' | 'phase'>): TaskStateMeta =>
  task.blocked ? TASK_STATUS_META.blocked : TASK_BOARD_LANE_META[taskBoardLane(task.phase)];

export type TaskAskOrigin = 'human' | 'agent' | 'unknown';

/**
 * New tasks carry the verbatim ask plus its source. Direct chat/message sources
 * are human asks; fleet/session artifacts are agent-originated work. Legacy
 * records without both pieces stay UNKNOWN rather than being guessed — a board
 * that invents provenance is worse than one that admits it has none.
 *
 * The fleet prefixes are ferretry's own, not kteam's: this daemon writes its
 * artifacts under its own state home, and `no-legacy-state.sh` forbids the old
 * ones anywhere under `packages/`. A record imported from kteam therefore reads
 * as `human`, which is the safe direction — it over-attributes to the person,
 * never the reverse.
 */
export const taskAskOrigin = (task: Pick<TaskSummary, 'askChars' | 'askSource'>): TaskAskOrigin => {
  const source = task.askSource.trim();
  if (task.askChars <= 0 || source === '' || /^(?:legacy:|#[BFIC][0-9]{1,9}$)/iu.test(source)) return 'unknown';
  const agentSource =
    /^(?:agent(?:\s|:)|ferretry(?:\s|:)|session:|turn:)/iu.test(source) ||
    /(?:^|[/\\])\.ferretry(?:[/\\]|$)/iu.test(source);
  return agentSource ? 'agent' : 'human';
};

/** An advisory overlap between two tasks' file claims — never a blocker. */
export interface TaskFileConflict {
  readonly taskId: string;
  readonly sessionId: string | null;
  /** Exact overlapping file strings. */
  readonly files: readonly string[];
  /** The other task belongs to a different session. */
  readonly crossSession: boolean;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/**
 * `yyyy-MM-dd HH:mm:ss` in the reader's own zone, matching kteam's
 * `fmtAbsolute`. Written out rather than taken from date-fns: the shipped
 * bundle is a public static artifact, and one format string is not worth a
 * dependency the coverage ledger cannot see through.
 *
 * An unparseable value is echoed back verbatim. It is a fact the daemon sent,
 * and replacing it with a plausible date would be a lie about audit data.
 */
export const absoluteTimestamp = (value: string | null | undefined): string => {
  if (!value) return '—';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};
