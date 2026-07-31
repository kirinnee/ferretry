import { summarizeTaskActivity } from './task-activity';
import {
  TASK_BOARD_LANE_ORDER,
  TASK_LANE_LABEL,
  TASK_STALENESS_COPY,
  TASK_STATUS_LABEL,
  taskBoardLaneFromPhase,
} from './task-board';
import { taskReference } from './task-id';
import type { TaskBoard, TaskDetail } from './task-render';

/** Markdown is a VIEW, never storage: nothing rendered here is ever written back to a record. */
const cell = (value: string | null | undefined): string => (value ?? '').replace(/\|/gu, '\\|').replace(/\n+/gu, ' ');

/**
 * The board as a markdown status report. The blocked strip leads, because "what I need from you" is
 * the only section the reader can act on; the remaining lanes follow in board order.
 */
export function renderTaskBoardMarkdown(board: TaskBoard): string {
  const lines: string[] = ['# Tasks', ''];
  const blocked = board.tasks.filter(task => task.blocked);
  const blockedIds = new Set(blocked.map(task => task.id));
  if (blocked.length > 0) {
    lines.push('## What I need from you', '');
    for (const task of blocked) {
      lines.push(`- **${taskReference(task.id)}** ${cell(task.title)} — ${cell(task.blockedReason)}`);
    }
    lines.push('');
  }
  for (const lane of TASK_BOARD_LANE_ORDER) {
    const rows = board.tasks.filter(task => !blockedIds.has(task.id) && taskBoardLaneFromPhase(task.phase) === lane);
    if (rows.length === 0) continue;
    lines.push(
      `## ${TASK_LANE_LABEL[lane]} (${rows.length})`,
      '',
      '| id | title | who | note |',
      '| --- | --- | --- | --- |',
    );
    for (const task of rows) {
      const stale = task.live.staleness === null ? '' : ` ⚠️ ${task.live.staleness}`;
      lines.push(
        `| ${taskReference(task.id)} | ${cell(task.title)} | ${cell(task.assignee)}${stale} | ${cell(task.statusReason)} |`,
      );
    }
    lines.push('');
  }
  if (board.tasks.length === 0) lines.push('_No tasks._', '');
  if (board.parseErrors > 0) {
    const ids = board.parseErrorIds === undefined ? '' : `: ${board.parseErrorIds.join(', ')}`;
    lines.push(`> ⚠️ ${board.parseErrors} task record(s) could not be read and are missing from this board${ids}`, '');
  }
  return lines.join('\n').trimEnd();
}

/** One task as a markdown brief: the declared record, the derived annotation, the ask, the history. */
export function renderTaskDetailMarkdown(detail: TaskDetail): string {
  const { task, activity } = detail;
  const lines: string[] = [
    `# ${taskReference(task.id)} · ${task.title}`,
    '',
    `- status: **${TASK_STATUS_LABEL[task.status]}**${task.statusReason === null ? '' : ` — ${task.statusReason}`}`,
    `- workflow: ${task.workflow}`,
    `- phase: ${task.phase}`,
    `- depends on: ${task.dependsOn.length > 0 ? task.dependsOn.map(taskReference).join(', ') : '—'}`,
    `- files (advisory): ${task.files.length > 0 ? task.files.map(file => `\`${file}\``).join(', ') : '—'}`,
    `- kind: ${task.kind}`,
    `- assignee: ${task.assignee ?? '—'}`,
    `- repo: ${task.repo ?? '—'}`,
    `- order: ${task.order ?? '—'}`,
    `- updated: ${task.updatedAt}`,
  ];
  if (task.live.staleness !== null) {
    lines.push(`- ⚠️ derived: ${TASK_STALENESS_COPY[task.live.staleness]} (declared status unchanged)`);
  }
  if (task.blocked) {
    const by = task.blockedBy.length > 0 ? ` (${task.blockedBy.map(taskReference).join(', ')})` : '';
    lines.push(`- 🚧 blocked since ${task.blockedSince ?? 'unknown'}: ${task.blockedReason ?? 'unknown'}${by}`);
  }

  const links = [
    ...task.links.prs.map(pr => `PR ${pr}`),
    ...(task.links.branch === null ? [] : [`branch ${task.links.branch}`]),
    ...task.links.commits.map(commit => `commit ${commit}`),
    ...task.links.docs.map(doc => `doc ${doc}`),
  ];
  if (links.length > 0) lines.push('', '## Links', '', ...links.map(link => `- ${link}`));

  lines.push('', '## Original ask', '', `> ${task.ask.text.replace(/\n/gu, '\n> ')}`, '', `Source: ${task.ask.source}`);
  if (task.clarifications.length > 0) {
    lines.push('', '## Clarifications', '');
    for (const item of task.clarifications) {
      lines.push(`- ${item.at} (${item.byName ?? item.by}): ${item.text} — ${item.source}`);
    }
  }
  lines.push('', '## Brief', '', task.description.trim().length > 0 ? task.description.trim() : '_No description._');
  lines.push('', '## Activity', '');
  if (activity.length === 0) lines.push('_No activity._');
  for (const entry of activity) {
    const actor = entry.actorName ?? entry.actor;
    lines.push(`- ${entry.seq}. \`${entry.time}\` **${entry.type}** (${actor}) ${summarizeTaskActivity(entry)}`);
  }
  if (detail.activityParseErrors !== undefined && detail.activityParseErrors > 0) {
    lines.push('', `> ⚠️ ${detail.activityParseErrors} history line(s) unreadable`);
  }
  return lines.join('\n');
}
