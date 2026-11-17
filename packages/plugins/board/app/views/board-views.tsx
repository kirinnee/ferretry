/**
 * THE BOARD'S VIEWS of one model: Kanban (the default), Table (see `board-table.tsx`), Tree, Dependencies and Archive.
 *
 * Every view draws the same `BoardCard`; they differ only in how the cards are arranged. The page owns
 * the data and hands each view a `BoardCardEnv`, so a view never reads the network. The views are READ-ONLY:
 * nothing is draggable and no lane takes a drop, the board moves its own cards.
 */

import { formatTaskRef } from '../../contract/index.ts';
import { type ReactNode, useMemo } from 'react';
import type { BoardModel } from '../lib/board-model.ts';
import type { FerretNames } from '../lib/board-present.ts';
import {
  ARCHIVE_PAGE,
  type BoardTaskOf,
  type BoardTaskPlace,
  type BoardGroupOf,
  buildTree,
  flattenTree,
} from '../lib/board-view.ts';
import { BoardTask } from './board-task.tsx';
import { BoardIcon } from './board-icons.tsx';
import { BoardLane } from './board-lane.tsx';
import { archiveRowsOf, TableRows } from './board-table.tsx';

/** What every view needs to draw and wire a card. */
export interface BoardTaskEnv {
  readonly names: FerretNames;
  readonly now: number;
  readonly showMachine: boolean;
  readonly hrefFor: (task: BoardTaskOf) => string;
  readonly onNavigate: (to: string) => void;
  readonly places: ReadonlyMap<string, BoardTaskPlace>;
  /** A phone: thumb-sized cards. */
  readonly touch?: boolean;
}

interface PlacedProps {
  readonly card: BoardTaskOf;
  readonly env: BoardTaskEnv;
  readonly lane?: string;
  readonly depth?: number;
}

export function PlacedTask({ card: task, env, lane, depth }: PlacedProps) {
  const place = env.places.get(task.key);
  return (
    <BoardTask
      card={task}
      category={place?.category ?? null}
      density="page"
      href={env.hrefFor(task)}
      names={env.names}
      now={env.now}
      onNavigate={env.onNavigate}
      showMachine={env.showMachine}
      touch={env.touch === true}
      {...(lane === undefined ? {} : { lane })}
      {...(depth === undefined ? {} : { depth })}
    />
  );
}

// ---------------------------------------------------------------------------------------------------
// Kanban
// ---------------------------------------------------------------------------------------------------

export interface KanbanViewProps {
  readonly model: BoardModel;
  readonly env: BoardTaskEnv;
  readonly projectName: (group: BoardGroupOf) => string;
  /** The Closed lane is not drawn (closed is hidden by default). */
  readonly hideClosed: boolean;
}

function KanbanBoard({
  group,
  env,
  hideClosed,
}: {
  readonly group: BoardGroupOf;
  readonly env: BoardTaskEnv;
  readonly hideClosed: boolean;
}) {
  const lanes = hideClosed ? group.lanes.filter(lane => lane.category !== 'closed') : group.lanes;
  return (
    <div className="fy-board-kanban">
      {lanes.map(lane => (
        <BoardLane category={lane.category} count={lane.cards.length} density="page" key={lane.id} name={lane.name}>
          {lane.cards.length === 0 ? (
            <li className="fy-board-lane__empty">Nothing here</li>
          ) : (
            lane.cards.map(task => <PlacedTask card={task} env={env} key={task.key} />)
          )}
        </BoardLane>
      ))}
      {group.unplaced.length === 0 ? null : (
        <BoardLane category={null} count={group.unplaced.length} density="page" name="Unplaced">
          {group.unplaced.map(task => (
            <PlacedTask card={task} env={env} key={task.key} />
          ))}
        </BoardLane>
      )}
    </div>
  );
}

/** One row of lanes per project (and machine); with a single project the heading is left out. */
export function KanbanView({ model, env, projectName, hideClosed }: KanbanViewProps) {
  const headed = model.groups.length > 1;
  return (
    <div className="fy-board-rows">
      {model.groups.map(group => (
        <section aria-label={headed ? projectName(group) : 'Board'} className="fy-board-project" key={group.key}>
          {headed ? (
            <h2 className="fy-board-project__head">
              {projectName(group)}
              {model.multiMachine ? <span className="fy-board-project__machine">{group.machine}</span> : null}
            </h2>
          ) : null}
          <KanbanBoard env={env} group={group} hideClosed={hideClosed} />
        </section>
      ))}
    </div>
  );
}

function Empty({ children }: { readonly children: ReactNode }) {
  return <p className="fy-board-empty">{children}</p>;
}

// ---------------------------------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------------------------------

export interface TreeViewProps {
  readonly model: BoardModel;
  readonly env: BoardTaskEnv;
}

/** A lead's card with its sub-ferrets' cards indented under it. */
export function TreeView({ model, env }: TreeViewProps) {
  const rows = useMemo(() => flattenTree(buildTree(model.cards)), [model.cards]);
  if (rows.length === 0) return <Empty>No tasks match.</Empty>;
  return (
    <ul className="fy-board-tree">
      {rows.map(row => (
        <PlacedTask
          card={row.card}
          depth={row.depth}
          env={env}
          key={row.card.key}
          lane={env.places.get(row.card.key)?.laneName ?? row.card.task.laneId}
        />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------------------

export interface DependenciesViewProps {
  readonly model: BoardModel;
  readonly env: BoardTaskEnv;
}

/**
 * Every card that waits on another or is waited on, each with its blockers and the cards it unblocks.
 * A list rather than a graph: the dependency lines are said in words under each card.
 */
export function DependenciesView({ model, env }: DependenciesViewProps) {
  const linked = model.cards.filter(task => task.task.blockedBy.length > 0 || task.task.blocks.length > 0);
  if (linked.length === 0) return <Empty>No task depends on another.</Empty>;
  return (
    <ul className="fy-board-deps">
      {linked.map(task => (
        <li className="fy-board-dep" key={task.key}>
          <ul className="fy-board-dep__card">
            <PlacedTask card={task} env={env} lane={env.places.get(task.key)?.laneName ?? task.task.laneId} />
          </ul>
          <p className="fy-board-dep__line">
            {task.task.blockedBy.length === 0 ? null : (
              <span data-dep="blocked-by">
                <BoardIcon name="blocked" /> waits on {task.task.blockedBy.map(formatTaskRef).join(', ')}
              </span>
            )}
            {task.task.blocks.length === 0 ? null : (
              <span data-dep="blocks">unblocks {task.task.blocks.map(formatTaskRef).join(', ')}</span>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------------------------------

export interface ArchiveViewProps {
  /** Closed and dropped cards, newest first, already narrowed by the search. */
  readonly shown: readonly BoardTaskOf[];
  readonly remaining: number;
  readonly total: number;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly onMore: () => void;
  readonly loading: boolean;
  readonly env: BoardTaskEnv;
}

/** Closed and dropped work, newest first, a page at a time, searchable. */
export function ArchiveView({ shown, remaining, total, query, onQuery, onMore, loading, env }: ArchiveViewProps) {
  return (
    <div className="fy-board-archive">
      <input
        aria-label="Search the archive"
        className="fy-board-archive__search"
        onChange={event => onQuery(event.target.value)}
        placeholder="Search closed and dropped tasks"
        type="search"
        value={query}
      />
      {shown.length === 0 ? (
        <Empty>
          {loading ? 'Reading the archive…' : query.trim() === '' ? 'Nothing closed yet.' : 'No archived task matches.'}
        </Empty>
      ) : (
        <TableRows env={env} rows={archiveRowsOf(shown, env)} />
      )}
      {remaining > 0 ? (
        <button className="kt-btn fy-board-archive__more" data-variant="ghost" onClick={onMore} type="button">
          Show {Math.min(remaining, ARCHIVE_PAGE)} more · {remaining} left of {total}
        </button>
      ) : null}
    </div>
  );
}
