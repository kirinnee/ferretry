import type { TaskActivity, TaskSummary, TaskView } from '@ferretry/protocol';
import { summarizeTaskActivity } from './task-activity';
import { TASK_BOARD_LANE_ORDER, TASK_LANE_LABEL, TASK_STALENESS_COPY, taskBoardLaneFromPhase } from './task-board';
import { taskReference } from './task-id';

/** The board shape every list rendering needs; both the session and fleet responses satisfy it. */
export interface TaskBoard {
  readonly tasks: readonly TaskSummary[];
  readonly parseErrors: number;
  readonly parseErrorIds?: readonly string[] | undefined;
}

/** The detail shape `show` renders; the session-scoped response satisfies it. */
export interface TaskDetail {
  readonly task: TaskView;
  readonly activity: readonly TaskActivity[];
  readonly activityParseErrors?: number | undefined;
}

const pad = (text: string, width: number): string =>
  text.length >= width ? text : text + ' '.repeat(width - text.length);

const instant = (value: string | null): number => {
  if (value === null) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

/** Subtraction would yield NaN for two unparseable timestamps; comparing keeps the order total. */
const compareInstants = (left: string | null, right: string | null): number => {
  const before = instant(left);
  const after = instant(right);
  return before === after ? 0 : before < after ? -1 : 1;
};

/** Blocked first, then stale, then the rest — the order in which a human should act on them. */
const urgency = (task: TaskSummary): number => (task.blocked ? 0 : task.live.staleness !== null ? 1 : 2);

const byUrgency = (left: TaskSummary, right: TaskSummary): number => {
  const difference = urgency(left) - urgency(right);
  if (difference !== 0) return difference;
  if (left.blocked && right.blocked) {
    const blocked = compareInstants(left.blockedSince, right.blockedSince);
    if (blocked !== 0) return blocked;
  }
  if (urgency(left) === 1) {
    const touched = compareInstants(left.updatedAt, right.updatedAt);
    if (touched !== 0) return touched;
  }
  return left.id.localeCompare(right.id, undefined, { numeric: true });
};

const parseErrorNotice = (board: TaskBoard): readonly string[] => {
  if (board.parseErrors === 0) return [];
  const ids = board.parseErrorIds === undefined ? '' : `: ${board.parseErrorIds.join(', ')}`;
  return ['', `⚠ ${board.parseErrors} task record(s) could not be read and are missing from this board${ids}`];
};

const summaryLine = (task: TaskSummary): string => {
  const blocked = task.blocked ? ` 🚧 ${task.blockedReason ?? 'reason unavailable'}` : '';
  const stale = task.live.staleness === null ? '' : ` ⚠ ${task.live.staleness}`;
  const lane = task.blocked ? 'BLOCKED' : taskBoardLaneFromPhase(task.phase).replace('_', ' ').toUpperCase();
  return `${pad(taskReference(task.id), 6)} ${pad(lane, 11)} ${pad(task.assignee ?? '—', 12)} ${task.title}${blocked}${stale}`;
};

/**
 * The default board. Tasks blocked with no blocking dependency are lifted into an ATTENTION strip,
 * because those are the ones only a human can unstick.
 */
export function renderTaskBoard(board: TaskBoard): string {
  if (board.tasks.length === 0) return ['No tasks.', ...parseErrorNotice(board)].join('\n');
  const ordered = [...board.tasks].sort(byUrgency);
  const attention = new Set(ordered.filter(task => task.blocked && task.blockedBy.length === 0).map(task => task.id));
  const lines: string[] = [];
  if (attention.size > 0) {
    lines.push('ATTENTION');
    for (const task of ordered) if (attention.has(task.id)) lines.push(summaryLine(task));
    if (attention.size < ordered.length) lines.push('');
  }
  for (const task of ordered) if (!attention.has(task.id)) lines.push(summaryLine(task));
  return [...lines, ...parseErrorNotice(board)].join('\n');
}

/** The same board grouped into lanes, in board order rather than urgency order. */
export function renderTaskKanban(board: TaskBoard): string {
  if (board.tasks.length === 0) return ['No tasks.', ...parseErrorNotice(board)].join('\n');
  const lines: string[] = [];
  for (const lane of TASK_BOARD_LANE_ORDER) {
    const tasks = board.tasks.filter(task => taskBoardLaneFromPhase(task.phase) === lane);
    if (tasks.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(`${TASK_LANE_LABEL[lane]} (${tasks.length})`);
    for (const task of tasks) {
      const blocked = task.blocked ? `BLOCKED 🚧 ${task.blockedReason ?? 'reason unavailable'} — ` : '';
      lines.push(`  ${taskReference(task.id)} ${blocked}${task.title}`);
    }
  }
  return [...lines, ...parseErrorNotice(board)].join('\n');
}

/** The dependency edges, one task per line. `∅` means nothing blocks it. */
export function renderTaskDag(board: TaskBoard): string {
  if (board.tasks.length === 0) return ['No tasks.', ...parseErrorNotice(board)].join('\n');
  const lines = board.tasks.map(task => {
    const edges = task.dependsOn.length > 0 ? task.dependsOn.map(taskReference).join(', ') : '∅';
    // kteam interpolated a null blockedReason here and printed "🚧 null".
    const blocked = task.blocked ? `  🚧 ${task.blockedReason ?? 'reason unavailable'}` : '';
    return `${taskReference(task.id)} → ${edges}${blocked}  ${task.title}`;
  });
  return [...lines, ...parseErrorNotice(board)].join('\n');
}

/** One task in full. The derived staleness line is labelled derived, so nobody reads it as a status. */
export function renderTaskDetail(detail: TaskDetail): string {
  const { task, activity } = detail;
  const lines = [
    `${taskReference(task.id)}  ${task.title}`,
    `workflow  ${task.workflow}`,
    `phase     ${task.phase}`,
    `status    ${task.status}${task.statusReason === null ? '' : ` — ${task.statusReason}`}`,
    `kind      ${task.kind}`,
    `assignee  ${task.assignee ?? '—'}${task.live.assigneeStatus === null ? '' : ` (${task.live.assigneeStatus})`}`,
    `repo      ${task.repo ?? '—'}`,
    `order     ${task.order ?? '—'}`,
    `updated   ${task.updatedAt}`,
  ];
  if (task.live.staleness !== null) lines.push(`⚠ derived  ${TASK_STALENESS_COPY[task.live.staleness]}`);
  if (task.blocked) {
    lines.push(`🚧 blocked  ${task.blockedReason ?? 'blocked'} since ${task.blockedSince ?? 'unknown'}`);
  }
  lines.push(`depends   ${task.dependsOn.length > 0 ? task.dependsOn.map(taskReference).join(', ') : '—'}`);
  lines.push(`files     ${task.files.length > 0 ? task.files.join(', ') : '—'} (advisory)`);

  const links = [
    ...task.links.prs.map(pr => `pr     ${pr}`),
    ...(task.links.branch === null ? [] : [`branch ${task.links.branch}`]),
    ...task.links.commits.map(commit => `commit ${commit}`),
    ...task.links.docs.map(doc => `doc    ${doc}`),
  ];
  if (links.length > 0) lines.push('', 'links', ...links.map(link => `  ${link}`));

  lines.push('', 'original ask', `  "${task.ask.text.replace(/\n/gu, '\n  ')}"`, `  source ${task.ask.source}`);
  if (task.clarifications.length > 0) {
    lines.push('', 'clarifications');
    for (const item of task.clarifications) lines.push(`  ${item.at} ${item.text} — ${item.source}`);
  }
  if (task.description.trim().length > 0) lines.push('', task.description.trim());

  lines.push('', `activity (${activity.length})`);
  for (const entry of activity) {
    const actor = entry.actorName ?? entry.actor;
    lines.push(
      `  ${pad(String(entry.seq), 4)} ${entry.time}  ${pad(entry.type, 9)} ${actor}  ${summarizeTaskActivity(entry)}`,
    );
  }
  if (detail.activityParseErrors !== undefined && detail.activityParseErrors > 0) {
    lines.push(`  ⚠ ${detail.activityParseErrors} history line(s) unreadable`);
  }
  return lines.join('\n');
}

/** What a mutation prints: the id, where it landed, and any derived warning. */
export function renderTaskAction(task: TaskView): string {
  const reason = task.statusReason === null ? '' : ` — ${task.statusReason}`;
  const stale = task.live.staleness === null ? '' : `  ⚠ ${TASK_STALENESS_COPY[task.live.staleness]}`;
  return `${taskReference(task.id)}  ${task.phase}${reason}${stale}`;
}
