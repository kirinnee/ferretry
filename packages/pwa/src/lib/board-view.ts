/**
 * THE BOARD'S VIEWS OF ONE MODEL: the Tree's nesting and the Archive's paging and search.
 *
 * `mergeBoard` has already grouped cards project → lane; these functions only re-read the same cards in
 * another shape. They never touch the network or the clock, so each is a plain value-to-value test.
 */

import type { LaneCategory } from '@ferretry/protocol';
import { type BoardFilters, type BoardModel, NO_BOARD_FILTERS } from './board-model.ts';

export type BoardCardOf = BoardModel['cards'][number];

export const BOARD_VIEWS = ['kanban', 'list', 'tree', 'dependencies', 'archive'] as const;
export type BoardViewId = (typeof BOARD_VIEWS)[number];

export const BOARD_VIEW_LABEL: Readonly<Record<BoardViewId, string>> = {
  kanban: 'Kanban',
  list: 'Table',
  tree: 'Tree',
  dependencies: 'Dependencies',
  archive: 'Archive',
};

export const parseBoardView = (value: string | null): BoardViewId =>
  BOARD_VIEWS.find(view => view === value) ?? 'kanban';

// ---------------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------------

/** A row of the List: the card, and where it sits on its board. */
export interface BoardListRow {
  readonly card: BoardCardOf;
  readonly projectId: string;
  readonly laneId: string;
  readonly laneName: string;
  readonly category: LaneCategory | null;
  /** Position of the card's project among the model's boards, then of its lane inside that board. */
  readonly place: readonly [number, number];
}

/** Every card of the model with its lane, in board order. */
export const listRows = (model: BoardModel): readonly BoardListRow[] =>
  model.groups.flatMap((group, groupIndex) => [
    ...group.lanes.flatMap((lane, laneIndex) =>
      lane.cards.map(card => ({
        card,
        projectId: group.projectId,
        laneId: lane.id,
        laneName: lane.name,
        category: lane.category,
        place: [groupIndex, laneIndex] as const,
      })),
    ),
    ...group.unplaced.map(card => ({
      card,
      projectId: group.projectId,
      laneId: card.task.laneId,
      laneName: card.task.laneId,
      category: null,
      place: [groupIndex, group.lanes.length] as const,
    })),
  ]);

// ---------------------------------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------------------------------

export interface BoardTreeNode {
  readonly card: BoardCardOf;
  readonly depth: number;
  /** The parent card is not on screen (filtered out or closed): this node is drawn as a root. */
  readonly detached: boolean;
  readonly children: readonly BoardTreeNode[];
}

/** One row of the Tree, flattened in reading order. */
export interface BoardTreeRow {
  readonly card: BoardCardOf;
  readonly depth: number;
  readonly detached: boolean;
  readonly childCount: number;
}

const siblingKey = (card: BoardCardOf): string => `${card.daemonId}\u0000${card.task.id}`;

/**
 * A lead's card with its sub-ferret cards indented under it. A card whose parent is not in `cards` is a
 * root of its own (`detached`, so the page can say its lead is out of view). The lead's children keep the
 * order `cards` gave them.
 */
export const buildTree = (cards: readonly BoardCardOf[]): readonly BoardTreeNode[] => {
  const present = new Map(cards.map(card => [siblingKey(card), card] as const));
  const childrenOf = new Map<string, BoardCardOf[]>();
  const roots: BoardCardOf[] = [];
  for (const card of cards) {
    const parent = card.task.parent;
    const parentKey = parent === null ? null : `${card.daemonId}\u0000${parent.id}`;
    if (parentKey !== null && present.has(parentKey)) {
      const siblings = childrenOf.get(parentKey);
      if (siblings === undefined) childrenOf.set(parentKey, [card]);
      else siblings.push(card);
    } else roots.push(card);
  }
  const node = (card: BoardCardOf, depth: number): BoardTreeNode => {
    const children = childrenOf.get(siblingKey(card)) ?? [];
    return {
      card,
      depth,
      detached: depth === 0 && card.task.parent !== null,
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

/** Newest first by when the card was last touched, else created. */
const archivedAt = (card: BoardCardOf): string => card.task.lastTouchedAt ?? card.task.createdAt;

/** Closed and dropped cards, newest first, narrowed by a search over id, title and summary. */
export const archiveRows = (cards: readonly BoardCardOf[], query: string): readonly BoardCardOf[] => {
  const needle = query.trim().toLocaleLowerCase();
  return cards
    .filter(card => {
      if (needle === '') return true;
      const { task } = card;
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

/** Where a card sits: the board (project on one machine) and the lane it is in. */
export interface BoardCardPlace {
  readonly group: BoardGroupOf;
  readonly laneName: string;
  readonly category: LaneCategory | null;
}

/** Every card's place by its key; the List, Tree and Archive need a card's lane without walking the lanes. */
export const cardPlaces = (model: BoardModel): ReadonlyMap<string, BoardCardPlace> => {
  const places = new Map<string, BoardCardPlace>();
  for (const group of model.groups) {
    for (const lane of group.lanes) {
      for (const card of lane.cards) places.set(card.key, { group, laneName: lane.name, category: lane.category });
    }
    for (const card of group.unplaced) {
      places.set(card.key, { group, laneName: card.task.laneId, category: null });
    }
  }
  return places;
};

/** The first (`closed`) or last (`active`) lane of a category on a board, or `null`: where "Works → Close" and "Not good" go. */
export const laneOfCategory = (
  group: BoardGroupOf,
  category: LaneCategory,
  which: 'first' | 'last' = 'first',
): string | null => {
  const matching = group.laneSet?.lanes.filter(lane => lane.category === category) ?? [];
  return (which === 'first' ? matching[0] : matching[matching.length - 1])?.id ?? null;
};
