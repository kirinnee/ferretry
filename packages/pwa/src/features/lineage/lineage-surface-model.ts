/**
 * Selection and filtering for the focused session's family tree.
 *
 * The underlying index is deliberately reused from `lib/lineage`: it already
 * owns cycle defence, sibling ordering, and the daemon data's missing-parent
 * semantics. This layer only selects the current family and preserves paths
 * when a status filter hides an intermediate ancestor.
 */
import type { SessionStatus, SessionView } from '@ferretry/protocol';

import { buildLineage, nestByLineage, parentDisplay, type NestedRow, type ParentDisplay } from '../../lib/lineage.ts';
import { shortSessionId } from '../../lib/callsign.ts';

export type LineageSurfaceParent = ParentDisplay | { readonly kind: 'invalid'; readonly shortId: string };

export interface LineageSurfaceModel {
  readonly current: SessionView | undefined;
  readonly parent: LineageSurfaceParent;
  readonly descendants: readonly NestedRow[];
  readonly descendantCount: number;
}

export interface FilteredLineageRow {
  readonly view: SessionView;
  readonly children: readonly FilteredLineageRow[];
  /** False means the row preserves the route to a matching descendant. */
  readonly matchesFilter: boolean;
}

export interface FilteredLineageTree {
  readonly rows: readonly FilteredLineageRow[];
  readonly matchCount: number;
  readonly contextCount: number;
}

export const STATUS_ORDER: readonly SessionStatus[] = [
  'running',
  'tool_running',
  'thinking',
  'starting',
  'created',
  'retrying',
  'rate_limited',
  'waiting',
  'awaiting_user',
  'awaiting_question',
  'interrupted',
  'completed',
  'failed',
  'stalled',
  'stopped',
  'kill_failed',
];

const findNestedRow = (rows: readonly NestedRow[], sessionId: string): NestedRow | undefined => {
  const pending = [...rows];
  while (pending.length > 0) {
    const row = pending.pop();
    if (!row) continue;
    if (row.view.config.id === sessionId) return row;
    pending.push(...row.children);
  }
  return undefined;
};

const countNestedRows = (rows: readonly NestedRow[]): number => {
  let count = 0;
  const pending = [...rows];
  while (pending.length > 0) {
    const row = pending.pop();
    if (!row) continue;
    count += 1;
    pending.push(...row.children);
  }
  return count;
};

/** Preserves non-matching ancestors only where they connect a true match. */
export const filterLineageRows = (
  rows: readonly NestedRow[],
  statuses: ReadonlySet<SessionStatus> | null,
): FilteredLineageTree => {
  let matchCount = 0;
  let contextCount = 0;

  const visit = (row: NestedRow): FilteredLineageRow | null => {
    const children = row.children.map(visit).filter((child): child is FilteredLineageRow => child !== null);
    const matchesFilter = statuses === null || statuses.has(row.view.state.status);
    if (!matchesFilter && children.length === 0) return null;
    if (matchesFilter) matchCount += 1;
    else contextCount += 1;
    return { view: row.view, children, matchesFilter };
  };

  return { rows: rows.map(visit).filter((row): row is FilteredLineageRow => row !== null), matchCount, contextCount };
};

/** `null` is the explicit all-status state. */
export const toggleLineageStatusFilter = (
  current: ReadonlySet<SessionStatus> | null,
  status: SessionStatus,
): ReadonlySet<SessionStatus> | null => {
  if (current === null) return new Set([status]);
  const next = new Set(current);
  if (next.has(status)) next.delete(status);
  else next.add(status);
  return next.size === 0 ? null : next;
};

export const lineageFilterSummary = (matchCount: number, contextCount: number): string =>
  `${matchCount} ${matchCount === 1 ? 'match' : 'matches'} · ${contextCount} ${contextCount === 1 ? 'path' : 'paths'}`;

/** Selects the focused node without rebuilding the shared lineage tree. */
export const buildLineageSurfaceModel = (sessionId: string, sessions: readonly SessionView[]): LineageSurfaceModel => {
  const byId = new Map(sessions.map(view => [view.config.id, view]));
  const current = byId.get(sessionId);
  if (!current) return { current: undefined, parent: null, descendants: [], descendantCount: 0 };

  const lineage = buildLineage(sessions);
  const currentRow = findNestedRow(nestByLineage(sessions, lineage), sessionId);
  const descendants = currentRow?.children ?? [];
  let parent: LineageSurfaceParent = parentDisplay(current.config.parent, byId);
  // `parentDisplay` can resolve a record whose link `buildLineage` rejected as
  // self-referential/cyclic. Never re-introduce that invalid edge as a parent.
  if (parent?.kind === 'resolved' && lineage.parentOf.get(sessionId) !== parent.view.config.id)
    parent = { kind: 'invalid', shortId: shortSessionId(parent.view.config.id) };

  return { current, parent, descendants, descendantCount: countNestedRows(descendants) };
};

/** The visible tree consists of the resolved parent (when safe), current row, and descendants. */
export const surfaceRows = (model: LineageSurfaceModel): readonly NestedRow[] => {
  if (!model.current) return [];
  const current: NestedRow = {
    view: model.current,
    depth: model.parent?.kind === 'resolved' ? 1 : 0,
    children: [...model.descendants],
  };
  if (model.parent?.kind !== 'resolved') return [current];
  return [{ view: model.parent.view, depth: 0, children: [current] }];
};

export const statusCounts = (rows: readonly NestedRow[]): ReadonlyMap<SessionStatus, number> => {
  const counts = new Map<SessionStatus, number>();
  const pending = [...rows];
  while (pending.length > 0) {
    const row = pending.pop();
    if (!row) continue;
    const status = row.view.state.status;
    counts.set(status, (counts.get(status) ?? 0) + 1);
    pending.push(...row.children);
  }
  return counts;
};

export const orderedStatuses = (
  counts: ReadonlyMap<SessionStatus, number>,
  selected: ReadonlySet<SessionStatus> | null,
): readonly SessionStatus[] => {
  const rank = new Map(STATUS_ORDER.map((status, index) => [status, index]));
  const visible = new Set(counts.keys());
  if (selected) for (const status of selected) visible.add(status);
  return [...visible].sort(
    (left, right) => (rank.get(left) ?? STATUS_ORDER.length) - (rank.get(right) ?? STATUS_ORDER.length),
  );
};
