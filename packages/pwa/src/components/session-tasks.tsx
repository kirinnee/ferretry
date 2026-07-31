/**
 * The task readings used inside a session: a priority list and a phase board.
 *
 * This is the presentation slice of kteam's `SessionTasks.tsx`. Fetching,
 * filters, detail drawers, and the cross-session dependency graph remain
 * separate feature increments; this component receives only the session's
 * already daemon-scoped task collection. The daemon id deliberately travels
 * into every row so an assignee link can never point at another pairing.
 */

import type { TaskBoardLane, TaskSummary } from '@ferretry/protocol';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { TASK_BOARD_LANE_META, taskBoardLane, type TaskFileConflict } from '../features/tasks/task-board-model.ts';
import { TaskRow } from '../features/tasks/task-row.tsx';

type SessionTaskConflicts = ReadonlyMap<string, readonly TaskFileConflict[]>;

const EMPTY_CONFLICTS: SessionTaskConflicts = new Map();
const LANES = Object.keys(TASK_BOARD_LANE_META) as TaskBoardLane[];

const timeOf = (value: string | null): number => {
  const parsed = value ? Date.parse(value) : Number.POSITIVE_INFINITY;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

/** ADHD list order: blocked work first, then stale work, then the oldest evidence. */
export const sortSessionTasks = (tasks: readonly TaskSummary[]): TaskSummary[] =>
  [...tasks].sort((left, right) => {
    const leftAttention = left.blocked ? 0 : left.live.staleness ? 1 : 2;
    const rightAttention = right.blocked ? 0 : right.live.staleness ? 1 : 2;
    if (leftAttention !== rightAttention) return leftAttention - rightAttention;
    const leftTime = timeOf(left.blockedSince ?? left.updatedAt ?? left.createdAt);
    const rightTime = timeOf(right.blockedSince ?? right.updatedAt ?? right.createdAt);
    if (leftTime !== rightTime) return leftTime - rightTime;
    const leftOrder = left.order ?? Number.POSITIVE_INFINITY;
    const rightOrder = right.order ?? Number.POSITIVE_INFINITY;
    return leftOrder - rightOrder || left.id.localeCompare(right.id);
  });

export interface SessionTaskListProps {
  readonly daemonId: DaemonId;
  readonly tasks: readonly TaskSummary[];
  readonly conflicts?: SessionTaskConflicts;
  readonly onOpen: (taskId: string) => void;
}

export function SessionTaskList({ daemonId, tasks, conflicts = EMPTY_CONFLICTS, onOpen }: SessionTaskListProps) {
  const visibleTasks = sortSessionTasks(tasks);
  return (
    <section
      aria-label="Session tasks"
      className="kt-panel overflow-hidden divide-y divide-border-soft"
      data-task-view="list"
    >
      {visibleTasks.map(task => (
        <TaskRow daemonId={daemonId} key={task.id} task={task} conflicts={conflicts.get(task.id)} onOpen={onOpen} />
      ))}
      {visibleTasks.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-muted">No matching tasks.</p>
      ) : null}
    </section>
  );
}

export interface SessionTaskKanbanProps extends SessionTaskListProps {
  /** Narrow screens trade horizontal travel for one normal reading column. */
  readonly compact?: boolean;
}

export function SessionTaskKanban({
  daemonId,
  tasks,
  conflicts = EMPTY_CONFLICTS,
  onOpen,
  compact = false,
}: SessionTaskKanbanProps) {
  return (
    <section
      aria-label="Session task board"
      className={compact ? 'flex min-w-0 flex-col gap-3 pb-2' : 'flex min-w-max gap-3 pb-2'}
      data-task-layout={compact ? 'stacked' : 'columns'}
      data-task-view="kanban"
    >
      {LANES.map(lane => {
        const laneTasks = sortSessionTasks(tasks.filter(task => taskBoardLane(task.phase) === lane));
        const meta = TASK_BOARD_LANE_META[lane];
        return (
          <section
            aria-label={`${meta.label} column`}
            className={`${compact ? 'w-full min-w-0' : 'w-64 shrink-0'} kt-task-tone kt-panel overflow-hidden`}
            data-task-lane={lane}
            data-tone={meta.tone}
            key={lane}
          >
            <div className="kt-panel__header justify-between">
              <span className="flex min-w-0 items-center gap-sm">
                <span aria-hidden="true" className="kt-task-tone-dot" />
                <h3 className="kt-label m-0">{meta.label}</h3>
              </span>
              <span className="kt-task-tone-ink text-xs font-semibold">{laneTasks.length}</span>
            </div>
            <div className="divide-y divide-border-soft">
              {laneTasks.map(task => (
                <TaskRow
                  daemonId={daemonId}
                  key={task.id}
                  task={task}
                  conflicts={conflicts.get(task.id)}
                  impliedLane={lane}
                  onOpen={onOpen}
                />
              ))}
              {laneTasks.length === 0 ? <p className="px-3 py-2 text-xs text-muted">No tasks.</p> : null}
            </div>
          </section>
        );
      })}
    </section>
  );
}
