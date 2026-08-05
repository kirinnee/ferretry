/**
 * The task row and the quick summary panel.
 *
 * Ported from kteam `ui/src/components/TaskPresentation.tsx` (`TaskRow`,
 * `TaskQuickSummary`, `TaskAskOriginMarker`), silhouettes and copy intact.
 *
 * The three refinements the original leans on, all kept:
 *
 *   * THE RAIL IS THE ALWAYS-ON SIGNAL. `.kt-task-rail` paints the row's left
 *     edge in the state tone with an inset shadow, not a border, so geometry
 *     (and the 44px target) never shifts and list dividers stay flush. That is
 *     why the status BADGE can be suppressed when a Kanban column or a
 *     homogeneous list already names the state: the colour still says it.
 *   * SUPPRESSION IS PER-FACT, NOT PER-ROW. `impliedLane`, `showStatusBadge`,
 *     `showAssignee` and `showAskOriginMarker` each remove one fact the
 *     surrounding context already carries, so a dense board does not repeat the
 *     same identity on every sibling.
 *   * BLOCKED ALWAYS SHOWS. `impliedLane` cannot suppress a blocked badge — a
 *     column labelled "In progress" full of quietly blocked work is the exact
 *     failure the board exists to prevent.
 *
 * MULTI-DAEMON: the row's session-scoped affordances (the assignee link) take a
 * `DaemonId`, so a row cannot deep-link into a different paired daemon.
 */

import { Bot, FileText, GitPullRequest, TriangleAlert } from 'lucide-react';
import type { TaskBoardLane, TaskSummary } from '@ferretry/protocol';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { cn } from '../../lib/class-names.ts';
import { parseGithubPr } from '../../lib/github-pr.ts';
import { Badge, Label } from '../../shell/primitives.tsx';
import { TaskAssigneeLink } from './task-assignee-link.tsx';
import {
  type TaskAskOrigin,
  type TaskFileConflict,
  absoluteTimestamp,
  taskAskOrigin,
  taskBoardLane,
  taskBoardState,
  taskReference,
} from './task-board-model.ts';
import { TASK_STALENESS_COPY } from './task-presentation.ts';

export interface TaskRowProps {
  readonly daemonId: DaemonId;
  readonly task: TaskSummary;
  readonly conflicts?: readonly TaskFileConflict[];
  readonly onOpen: (id: string) => void;
  readonly onNavigate?: (to: string) => void;
  /** A Kanban column already names its lane. Only exceptional blocked state
   *  still needs a badge there; mixed list rows keep their status by default. */
  readonly impliedLane?: TaskBoardLane;
  /** Homogeneous lists already expose their one status in the shared filter. */
  readonly showStatusBadge?: boolean;
  /** Visible-set context suppresses an identity repeated on every sibling. */
  readonly showAssignee?: boolean;
  /** Ask provenance distinguishes only when the visible set mixes origins. */
  readonly showAskOriginMarker?: boolean;
  /** Human-facing completion is offered only for work awaiting live verification. */
  readonly onMarkDone?: (task: TaskSummary) => void;
  readonly markingDone?: boolean;
}

export function TaskRow({
  daemonId,
  task,
  conflicts,
  onOpen,
  onNavigate,
  impliedLane,
  showStatusBadge = true,
  showAssignee = true,
  showAskOriginMarker = true,
  onMarkDone,
  markingDone = false,
}: TaskRowProps) {
  const lane = taskBoardLane(task.phase);
  const boardState = taskBoardState(task);
  const statusIsImplied = !showStatusBadge || (!task.blocked && impliedLane === lane);
  const stale = task.live.staleness ? TASK_STALENESS_COPY[task.live.staleness] : null;
  const phaseNote = !task.blocked && task.phase !== 'dropped' ? task.statusReason : null;
  const pr = task.links.prs.map(parseGithubPr).find(Boolean) ?? null;
  const hasConflicts = conflicts !== undefined && conflicts.length > 0;
  return (
    <div
      data-task-id={task.id}
      data-tone={boardState.tone}
      className="kt-task-tone kt-task-rail group min-w-0 px-3 py-2 hover:bg-surface-2"
    >
      <button
        type="button"
        onClick={() => onOpen(task.id)}
        className="flex min-h-[44px] w-full min-w-0 flex-col justify-center gap-1 text-left focus-visible:z-10"
        aria-label={`Open ${taskReference(task.id)}: ${task.title}`}
      >
        <span
          data-task-title={task.id}
          className="block w-full whitespace-normal break-words text-row font-semibold leading-tight text-fg"
        >
          {task.title}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="mono shrink-0 text-2xs font-medium text-faint">{taskReference(task.id)}</span>
          {showAskOriginMarker && <TaskAskOriginMarker origin={taskAskOrigin(task)} compact />}
          {!statusIsImplied && (
            <Badge data-task-status-badge tone={boardState.tone} className="shrink-0 whitespace-nowrap">
              {boardState.label}
            </Badge>
          )}
          {stale && (
            <span className="inline-flex shrink-0" title={stale.reason}>
              {/* The reason, not the glyph, is what a screen reader needs. */}
              <span className="sr-only">{stale.reason}</span>
              <Badge tone="warn" className="animate-pulse motion-reduce:animate-none">
                !
              </Badge>
            </span>
          )}
        </span>
        <span className="block w-full min-w-0">
          {task.blocked && task.blockedReason !== null && (
            <span className="mt-0.5 block truncate text-xs font-medium text-warn">{task.blockedReason}</span>
          )}
          {phaseNote !== null && (
            <span className="mt-0.5 block truncate text-xs font-medium text-warn" title={phaseNote}>
              Phase note · {phaseNote}
            </span>
          )}
          {task.blockedBy.length > 0 && (
            <span className="mt-0.5 block truncate text-xs text-warn">
              Blocked by {task.blockedBy.map(taskReference).join(', ')}
            </span>
          )}
          {task.dependsOn.length > 0 && (
            <span className="mt-0.5 block truncate text-xs text-muted">
              Depends on {task.dependsOn.map(taskReference).join(', ')}
            </span>
          )}
          {task.files.length > 0 && (
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted">
              <FileText size={11} aria-hidden="true" className="shrink-0" />
              <span className="truncate">{task.files.join(', ')}</span>
            </span>
          )}
          {hasConflicts && (
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-warn">
              <TriangleAlert size={11} aria-hidden="true" className="shrink-0" />
              <span className="truncate">
                Shares files with {conflicts.map(conflict => taskReference(conflict.taskId)).join(', ')}
              </span>
            </span>
          )}
        </span>
      </button>
      {onMarkDone !== undefined && task.phase === 'live' ? (
        <div className="mt-1 flex justify-end">
          <button
            aria-label={`Mark ${taskReference(task.id)} done`}
            className="kt-btn kt-btn--sm"
            data-variant="primary"
            disabled={markingDone}
            onClick={() => onMarkDone(task)}
            type="button"
          >
            {markingDone ? 'Marking done…' : 'Mark done'}
          </button>
        </div>
      ) : null}
      {(showAssignee || pr !== null) && (
        // Without an assignee the strip carries only the PR chip, which is
        // desktop-only — so the whole strip stays out of the phone layout too.
        <div className={cn('mt-1 min-w-0 items-center gap-2', showAssignee ? 'flex' : 'hidden sm:flex')}>
          {showAssignee && (
            <TaskAssigneeLink
              daemonId={daemonId}
              task={task}
              showStatus={false}
              className="max-w-full"
              onNavigate={onNavigate}
            />
          )}
          {pr !== null && (
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              title={`Open ${pr.org}/${pr.repo} PR #${pr.number}`}
              aria-label={`Open ${pr.org}/${pr.repo} pull request ${pr.number}`}
              className="ml-auto hidden shrink-0 items-center gap-1 rounded-control border border-border-soft px-1.5 py-1 text-xs text-muted hover:text-fg sm:inline-flex"
            >
              <GitPullRequest size={13} aria-hidden="true" />
              {pr.repo}#{pr.number}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export interface TaskAskOriginMarkerProps {
  readonly origin: TaskAskOrigin;
  readonly compact?: boolean;
}

/**
 * Compact form shows ONLY the agent case. In a fleet UI human-asked is the
 * unremarkable default, so marking it on every row would be noise; the detail
 * surface has room to name all three.
 */
export function TaskAskOriginMarker({ origin, compact = false }: TaskAskOriginMarkerProps) {
  if (compact) {
    if (origin !== 'agent') return null;
    return (
      <span
        data-task-ask-origin="agent"
        className="inline-flex shrink-0 items-center text-faint"
        title="Original ask came from an agent"
      >
        <Bot size={11} aria-hidden="true" />
        <span className="sr-only">Agent-originated</span>
      </span>
    );
  }
  const label = origin === 'agent' ? 'Agent-originated' : origin === 'human' ? 'Human-asked' : 'Ask origin unknown';
  const title =
    origin === 'agent'
      ? 'Original ask came from an agent'
      : origin === 'human'
        ? 'Original ask came from the human'
        : 'Original ask provenance is unavailable';
  return (
    <span
      data-task-ask-origin={origin}
      className={cn(
        'mt-0.5 inline-flex w-fit items-center gap-1 rounded-control border px-1.5 py-0.5 text-2xs font-semibold',
        origin === 'agent'
          ? 'border-accent-border bg-accent-soft text-accent'
          : 'border-border-soft bg-surface text-muted',
      )}
      title={title}
    >
      {origin === 'agent' && <Bot size={11} aria-hidden="true" />}
      {label}
    </span>
  );
}

export interface TaskQuickSummaryProps {
  readonly task: TaskSummary;
}

/**
 * The one tinted panel in task detail. It follows the task's OWN state tone
 * rather than a fixed accent, so blocked reads urgent and done reads settled
 * before a word is parsed.
 */
export function TaskQuickSummary({ task }: TaskQuickSummaryProps) {
  const state = taskBoardState(task);
  const assignee = task.live.assigneeName?.trim() || task.assignee?.trim() || null;
  const blocker = task.blockedReason ?? task.statusReason ?? 'Blocked; no reason recorded.';
  const phaseNote = !task.blocked && task.phase !== 'dropped' ? task.statusReason : null;
  const headingId = `task-quick-summary-${task.id}`;
  return (
    <section aria-labelledby={headingId} data-tone={state.tone} className="kt-task-tone kt-task-summary p-3">
      <Label id={headingId}>Quick summary</Label>
      <div className="mt-2 flex flex-col gap-1.5 text-ui leading-relaxed text-fg">
        <p>
          <strong>{state.label}.</strong>
        </p>
        <p>{task.title}</p>
        {task.blocked && <p className="whitespace-pre-wrap break-words text-warn">{blocker}</p>}
        {phaseNote !== null && <p className="whitespace-pre-wrap break-words text-warn">Phase note · {phaseNote}</p>}
        {task.blockedBy.length > 0 && <p>Waiting on {task.blockedBy.map(taskReference).join(', ')}.</p>}
        {task.blockedSince !== null && <p>Blocked since {absoluteTimestamp(task.blockedSince)}.</p>}
        <p>{assignee === null ? 'Unassigned.' : `Assigned to ${assignee}.`}</p>
        {task.dependsOn.length > 0 && <p>Depends on {task.dependsOn.map(taskReference).join(', ')}.</p>}
      </div>
    </section>
  );
}
