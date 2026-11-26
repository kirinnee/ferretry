/**
 * ONE PROJECT'S HEADING on the Kanban: its name (always, even when it is the only project, so the owner can tell what
 * the lanes belong to), how many tasks it holds, a fold that tucks the project's lanes away, and ONE plain control —
 * "Only this project" narrows the board to it, "All projects" widens it back. It draws the project's own row of lanes'
 * header and nothing else: the page owns the filter and the project's lanes are the caller's children.
 */

import type { BoardProjectId } from '../../contract/index.ts';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';

/** What the page does with the project filter: the project it is narrowed to, and how to change it. */
export interface BoardProjectFocus {
  readonly projectId: BoardProjectId | null;
  readonly onFocus: (projectId: BoardProjectId | null) => void;
}

export interface BoardProjectProps {
  readonly name: string;
  readonly projectId: BoardProjectId;
  /** The machine's name, when several machines are on the board. */
  readonly machine: string | null;
  readonly count: number;
  readonly focus?: BoardProjectFocus | undefined;
  /** Whether more than one project is on the board: "Only this project" is offered only then (or to undo it). */
  readonly several: boolean;
  readonly children: ReactNode;
}

const taskWords = (count: number): string => `${String(count)} ${count === 1 ? 'task' : 'tasks'}`;

export function BoardProject({ name, projectId, machine, count, focus, several, children }: BoardProjectProps) {
  const [collapsed, setCollapsed] = useState(false);
  const bodyId = useId();
  const narrowed = focus?.projectId === projectId;
  const control =
    focus === undefined ? null : narrowed ? (
      <button
        className="fy-board-project__focus"
        data-project-focus="all"
        onClick={() => focus.onFocus(null)}
        type="button"
      >
        All projects
      </button>
    ) : several ? (
      <button
        className="fy-board-project__focus"
        data-project-focus="only"
        onClick={() => focus.onFocus(projectId)}
        title={`Show only ${name} on the board`}
        type="button"
      >
        Only this project
      </button>
    ) : null;
  return (
    <section aria-label={`${name}, ${taskWords(count)}`} className="fy-board-project" data-project={projectId}>
      <h2 className="fy-board-project__head">
        <button
          aria-controls={bodyId}
          aria-expanded={!collapsed}
          className="fy-board-project__toggle"
          onClick={() => setCollapsed(value => !value)}
          type="button"
        >
          {collapsed ? <ChevronRight aria-hidden="true" size={14} /> : <ChevronDown aria-hidden="true" size={14} />}
          <span className="fy-board-project__name">{name}</span>
        </button>
        <span className="fy-board-project__count">{taskWords(count)}</span>
        {machine === null ? null : <span className="fy-board-project__machine">{machine}</span>}
        {control}
      </h2>
      {collapsed ? null : <div id={bodyId}>{children}</div>}
    </section>
  );
}
