/**
 * THE BOARD'S VIEWS OF ONE MODEL: the Tree's nesting and the Archive's paging and search.
 *
 * `mergeBoard` has already grouped tasks project → lane; these functions only re-read the same tasks in
 * another shape. They never touch the network or the clock, so each is a plain value-to-value test.
 */

import type { LaneCategory } from '../../contract/index.ts';
import { type BoardFilters, type BoardModel, NO_BOARD_FILTERS } from './board-model.ts';

export type BoardTaskOf = BoardModel['cards'][number];

export const BOARD_VIEWS = ['kanban', 'list', 'tree', 'dependencies', 'archive'] as const;
export type BoardViewId = (typeof BOARD_VIEWS)[number];

export const BOARD_VIEW_LABEL: Readonly<Record<BoardViewId, string>> = {
  kanban: 'Kanban',
  list: 'Table',
  tree: 'Tree',
  dependencies: 'Dependencies',
  archive: 'Archive',
};

/** One plain line per view, said as the tab's tooltip: what the view is for, so no tab is a guess. */
export const BOARD_VIEW_HINT: Readonly<Record<BoardViewId, string>> = {
  kanban: 'Each project is a row; its lanes are the steps a task moves through',
  list: 'Every task in one table',
  tree: 'Tasks nested under the task they belong to',
  dependencies: 'Which task waits on which',
  archive: 'Closed and dropped tasks',
};

export const parseBoardView = (value: string | null): BoardViewId =>
  BOARD_VIEWS.find(view => view === value) ?? 'kanban';

// ---------------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------------

/** A row of the List: the task, and where it sits on its board. */
export interface BoardListRow {
  readonly card: BoardTaskOf;
  readonly projectId: string;
  readonly laneId: string;
  readonly laneName: string;
  readonly category: LaneCategory | null;
  /** Position of the task's project among the model's boards, then of its lane inside that board. */
  readonly place: readonly [number, number];
}

/** Every task of the model with its lane, in board order. */
export const listRows = (model: BoardModel): readonly BoardListRow[] =>
  model.groups.flatMap((group, groupIndex) => [
    ...group.lanes.flatMap((lane, laneIndex) =>
      lane.cards.map(task => ({
        card: task,
        projectId: group.projectId,
        laneId: lane.id,
        laneName: lane.name,
        category: lane.category,
        place: [groupIndex, laneIndex] as const,
      })),
    ),
    ...group.unplaced.map(task => ({
      card: task,
      projectId: group.projectId,
      laneId: task.task.laneId,
      laneName: task.task.laneId,
      category: null,
      place: [groupIndex, group.lanes.length] as const,
    })),
  ]);

// ---------------------------------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------------------------------

export interface BoardTreeNode {
  readonly card: BoardTaskOf;
  readonly depth: number;
  /** The parent task is not on screen (filtered out or closed): this node is drawn as a root. */
  readonly detached: boolean;
  readonly children: readonly BoardTreeNode[];
}

/** One row of the Tree, flattened in reading order. */
export interface BoardTreeRow {
  readonly card: BoardTaskOf;
  readonly depth: number;
  readonly detached: boolean;
  readonly childCount: number;
}

const siblingKey = (task: BoardTaskOf): string => `${task.daemonId}\u0000${task.task.id}`;

/**
 * A lead's task with its sub-ferret tasks indented under it. A task whose parent is not in `tasks` is a
 * root of its own (`detached`, so the page can say its lead is out of view). The lead's children keep the
 * order `tasks` gave them.
 */
export const buildTree = (tasks: readonly BoardTaskOf[]): readonly BoardTreeNode[] => {
  const present = new Map(tasks.map(task => [siblingKey(task), task] as const));
  const childrenOf = new Map<string, BoardTaskOf[]>();
  const roots: BoardTaskOf[] = [];
  for (const task of tasks) {
    const parent = task.task.parent;
    const parentKey = parent === null ? null : `${task.daemonId}\u0000${parent.id}`;
    if (parentKey !== null && present.has(parentKey)) {
      const siblings = childrenOf.get(parentKey);
      if (siblings === undefined) childrenOf.set(parentKey, [task]);
      else siblings.push(task);
    } else roots.push(task);
  }
  const node = (task: BoardTaskOf, depth: number): BoardTreeNode => {
    const children = childrenOf.get(siblingKey(task)) ?? [];
    return {
      card: task,
      depth,
      detached: depth === 0 && task.task.parent !== null,
      children: children.map(child => node(child, depth + 1)),
    };
  };
  return roots.map(root => node(root, 0));
};

export const flattenTree = (nodes: readonly BoardTreeNode[]): readonly BoardTreeRow[] =>
  nodes.flatMap(entry => [
    { card: entry.card, depth: entry.depth, detached: entry.detached, childCount: entry.children.length },
    ...flattenTree(entry.children),
  ]);

// ---------------------------------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------------------------------

export const ARCHIVE_PAGE = 25;

/** Newest first by when the task was last touched, else created. */
const archivedAt = (task: BoardTaskOf): string => task.task.lastTouchedAt ?? task.task.createdAt;

/** Closed and dropped tasks, newest first, narrowed by a search over id, title and summary. */
export const archiveRows = (tasks: readonly BoardTaskOf[], query: string): readonly BoardTaskOf[] => {
  const needle = query.trim().toLocaleLowerCase();
  return tasks
    .filter(boardTask => {
      if (needle === '') return true;
      const { task } = boardTask;
      return [task.id, task.title, task.summary].some(text => text.toLocaleLowerCase().includes(needle));
    })
    .sort((left, right) => archivedAt(right).localeCompare(archivedAt(left)) || left.key.localeCompare(right.key));
};

/** The first `pages` pages of `rows`, and whether more remain. */
export const archivePage = <T>(
  rows: readonly T[],
  pages: number,
): { readonly shown: readonly T[]; readonly remaining: number } => {
  const size = Math.max(1, pages) * ARCHIVE_PAGE;
  return { shown: rows.slice(0, size), remaining: Math.max(0, rows.length - size) };
};

// ---------------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------------

const rangeActive = (range: BoardFilters['created']): boolean =>
  range.preset !== null || range.from !== null || range.to !== null;

/** How many filters narrow the board beyond its defaults: the number the Filters button shows. */
export const activeFilterCount = (filters: BoardFilters): number =>
  [
    filters.project !== null,
    filters.machine !== null,
    filters.ferret !== null,
    filters.kind !== null,
    filters.pr !== null,
    filters.state !== NO_BOARD_FILTERS.state,
    filters.activity !== null,
    filters.mine,
    filters.lane !== null,
    rangeActive(filters.created),
    rangeActive(filters.touched),
  ].filter(Boolean).length;

/** The distinct lane names across every board, in the order first met: what the Lane filter offers. */
export const laneNames = (model: BoardModel): readonly string[] => {
  const names: string[] = [];
  for (const group of model.groups) {
    for (const lane of group.lanes) if (!names.includes(lane.name)) names.push(lane.name);
  }
  return names;
};

// ---------------------------------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------------------------------

export type BoardGroupOf = BoardModel['groups'][number];

/** Where a task sits: the board (project on one machine) and the lane it is in. */
export interface BoardTaskPlace {
  readonly group: BoardGroupOf;
  readonly laneName: string;
  readonly category: LaneCategory | null;
}

/** Every task's place by its key; the List, Tree and Archive need a task's lane without walking the lanes. */
export const taskPlaces = (model: BoardModel): ReadonlyMap<string, BoardTaskPlace> => {
  const places = new Map<string, BoardTaskPlace>();
  for (const group of model.groups) {
    for (const lane of group.lanes) {
      for (const task of lane.cards) places.set(task.key, { group, laneName: lane.name, category: lane.category });
    }
    for (const task of group.unplaced) {
      places.set(task.key, { group, laneName: task.task.laneId, category: null });
    }
  }
  return places;
};

/** How many tasks a project's row of lanes holds, as drawn: the Closed lane is left out while closed work is hidden. */
export const groupTaskCount = (group: BoardGroupOf, hideClosed: boolean): number =>
  group.unplaced.length +
  group.lanes.reduce((sum, lane) => sum + (hideClosed && lane.category === 'closed' ? 0 : lane.cards.length), 0);
