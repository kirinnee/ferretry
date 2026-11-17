/**
 * ONE BOARD TASK: the title (truncated), its one-line summary (truncated, when it has one), and a meta line of
 * short segments (`&F412 · ● 4m · How to test · PR ✓ · ⛓ 1 · subs 2/3 · owner→assignee`; on a task to test, How to
 * test comes before the activity). A task waiting to be tested that says nothing about how wears a quiet "no test
 * steps" instead.
 *
 * It is the only task renderer. The full-page Board, the phone and the per-chat side pane all draw it, and
 * `density` is the only thing that differs: `side` keeps one short line by dropping the summary and the
 * segments that are marked optional (who, shipped-in, machine).
 *
 * A task is a real link to its detail (`/d/<id>/board/<taskId>`) and nothing more: it is not draggable and has no
 * lane menu, no Done, no Not good, no Reopen. The board runs itself and the owner answers a task where it asks, in
 * the agenda; the task only says where the work stands. The one control is "Add to chat" (the per-chat Tasks tab),
 * which puts the task's `&F18` in the chat's draft — it writes to no task.
 *
 * `touch` is the phone: thumb-sized targets.
 */

import { formatTaskRef, type LaneCategory } from '../../contract/index.ts';
import { MessageSquarePlus } from 'lucide-react';
import type { CSSProperties } from 'react';
import { taskSegments, type FerretNames } from '../lib/board-present.ts';
import type { BoardTaskOf } from '../lib/board-view.ts';
import { plainPreview } from '../lib/plain-label.ts';
import { RouteLink } from '@ferretry/app/ui';
import { BoardIcon } from './board-icons.tsx';

export type BoardDensity = 'page' | 'side';

export interface BoardTaskProps {
  readonly card: BoardTaskOf;
  readonly density: BoardDensity;
  readonly category: LaneCategory | null;
  readonly names: FerretNames;
  readonly now: number;
  /** More than one machine is on the board: say which machine the task is on. */
  readonly showMachine: boolean;
  /** Where the task opens. */
  readonly href: string;
  readonly onNavigate?: (to: string) => void;
  /** The lane's name, shown first on the meta line (List and Tree, where tasks are not under a lane header). */
  readonly lane?: string;
  /** Nesting under a lead, for the Tree. */
  readonly depth?: number;
  /** Present where a task can be pointed at from a chat (the per-chat Tasks tab): puts the task's `&F18` in the draft. */
  readonly onAddToChat?: (task: BoardTaskOf) => void;
  /** A phone: bigger targets. */
  readonly touch?: boolean;
}

export function BoardTask({
  card: boardTask,
  density,
  category,
  names,
  now,
  showMachine,
  href,
  onNavigate,
  lane,
  depth,
  onAddToChat,
  touch = false,
}: BoardTaskProps) {
  const { task } = boardTask;
  const preview = plainPreview(task.summary);
  const segments = taskSegments(task, {
    names,
    now,
    category,
    machine: showMachine ? boardTask.machine : null,
  }).filter(segment => density === 'page' || !segment.optional);
  return (
    <li
      className="fy-board-card"
      data-activity={task.activity}
      data-category={category ?? 'unplaced'}
      data-density={density}
      data-depth={depth}
      data-kind={task.kind}
      data-task={task.id}
      data-touch={touch ? '' : undefined}
      style={depth === undefined ? undefined : ({ '--fy-board-depth': depth } as CSSProperties)}
    >
      <RouteLink
        className="fy-board-card__main"
        draggable={false}
        onNavigate={onNavigate}
        title={preview === '' ? task.title : `${task.title} — ${preview}`}
        to={href}
      >
        <span className="fy-board-card__title">{task.title}</span>
        {density === 'side' || preview === '' ? null : <span className="fy-board-card__summary">{preview}</span>}
        <span className="fy-board-card__meta">
          {lane === undefined ? null : (
            <span className="fy-board-seg" data-seg="lane" data-tone="quiet" title="Lane">
              {lane}
            </span>
          )}
          {segments.map(segment => (
            <span
              className="fy-board-seg"
              data-seg={segment.key}
              data-tone={segment.tone}
              key={segment.key}
              title={segment.title}
            >
              {segment.icon === null ? null : <BoardIcon name={segment.icon} />}
              {segment.text}
            </span>
          ))}
        </span>
      </RouteLink>
      {onAddToChat === undefined ? null : (
        <button
          aria-label={`Add ${formatTaskRef(task)} to chat`}
          className="fy-board-card__chat"
          data-add-to-chat={task.id}
          onClick={() => onAddToChat(boardTask)}
          title="Add to chat"
          type="button"
        >
          <MessageSquarePlus aria-hidden="true" size={12} />
        </button>
      )}
    </li>
  );
}
