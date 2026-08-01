/**
 * Safe session-lineage indexing and display helpers.
 *
 * Parent ids come from daemon records, so missing records and malformed cycles
 * are treated as roots instead of allowing a side-pane tree to recurse forever.
 */
import type { SessionView } from '@ferretry/protocol';

import { parseTaskName, taskIsRedundant } from '../shell/task-name.ts';
import { displayCallsign, shortSessionId } from './callsign.ts';

/** Sidebar indentation stops growing after two 10px steps. */
export const MAX_INDENT_DEPTH = 2;
const INDENT_PER_LEVEL = 10;

export const lineageIndent = (depth: number): number => {
  const wholeDepth = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  return Math.min(wholeDepth, MAX_INDENT_DEPTH) * INDENT_PER_LEVEL;
};

export interface LineageIndex {
  readonly childrenOf: ReadonlyMap<string, SessionView[]>;
  readonly parentOf: ReadonlyMap<string, string>;
  readonly depthOf: ReadonlyMap<string, number>;
}

export interface NestedRow {
  readonly view: SessionView;
  depth: number;
  readonly children: NestedRow[];
  spawnedBy?: string;
}

export type ParentDisplay =
  | { readonly kind: 'resolved'; readonly view: SessionView; readonly name: string }
  | { readonly kind: 'missing'; readonly shortId: string }
  | null;

export interface LineageLabel {
  readonly callsign: string;
  readonly task: string;
  readonly text: string;
  readonly full: string;
}

export const lineageLabel = (view: SessionView): LineageLabel => {
  const callsign = displayCallsign(view.config.teammate);
  const parsedTask = parseTaskName(view.config.name).task;
  const task = taskIsRedundant(view.config.name, view.config.teammate) ? '' : parsedTask;
  const text = callsign && task ? `${callsign} · ${task}` : callsign || task || shortSessionId(view.config.id);
  return { callsign, task, text, full: `${text} · ${view.config.id}` };
};

/** Resolve by id, never by a recyclable teammate callsign. */
export const parentDisplay = (parentId: string | undefined, byId: ReadonlyMap<string, SessionView>): ParentDisplay => {
  const id = parentId?.trim();
  if (!id) return null;
  const view = byId.get(id);
  return view
    ? { kind: 'resolved', view, name: lineageLabel(view).text }
    : { kind: 'missing', shortId: shortSessionId(id) };
};

/** Find every cycle member so every invalid edge can be discarded. */
const cyclicIds = (parentOf: ReadonlyMap<string, string>): Set<string> => {
  const cyclic = new Set<string>();
  const settled = new Set<string>();
  for (const start of parentOf.keys()) {
    if (settled.has(start)) continue;
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = start;
    while (current && !settled.has(current)) {
      const seenAt = position.get(current);
      if (seenAt !== undefined) {
        for (const id of path.slice(seenAt)) cyclic.add(id);
        break;
      }
      position.set(current, path.length);
      path.push(current);
      if (path.length > parentOf.size) break;
      current = parentOf.get(current);
    }
    for (const id of path) settled.add(id);
  }
  return cyclic;
};

const buildDepths = (sessions: readonly SessionView[], parentOf: ReadonlyMap<string, string>): Map<string, number> => {
  const depthOf = new Map<string, number>();
  for (const view of sessions) {
    const start = view.config.id;
    if (depthOf.has(start)) continue;
    const path: string[] = [];
    const inPath = new Set<string>();
    let current: string | undefined = start;
    while (current && !depthOf.has(current) && !inPath.has(current)) {
      inPath.add(current);
      path.push(current);
      if (path.length > parentOf.size + 1) break;
      current = parentOf.get(current);
    }
    let parentDepth = current ? (depthOf.get(current) ?? 0) : 0;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const id = path[index];
      if (id === undefined) continue;
      if (!parentOf.has(id)) parentDepth = 0;
      else parentDepth += 1;
      depthOf.set(id, parentDepth);
    }
  }
  return depthOf;
};

/** Build a safe index; missing, self and cyclic parent links become roots. */
export const buildLineage = (sessions: readonly SessionView[]): LineageIndex => {
  const byId = new Map<string, SessionView>();
  for (const view of sessions) byId.set(view.config.id, view);

  const parentOf = new Map<string, string>();
  for (const view of sessions) {
    const id = view.config.id;
    const parent = view.config.parent?.trim();
    if (!parent || parent === id || !byId.has(parent)) continue;
    parentOf.set(id, parent);
  }
  for (const id of cyclicIds(parentOf)) parentOf.delete(id);

  const childrenOf = new Map<string, SessionView[]>();
  for (const view of sessions) {
    const parent = parentOf.get(view.config.id);
    if (!parent) continue;
    const children = childrenOf.get(parent);
    if (children) children.push(view);
    else childrenOf.set(parent, [view]);
  }
  return { childrenOf, parentOf, depthOf: buildDepths(sessions, parentOf) };
};

const activityAt = (view: SessionView): number => {
  const value = Date.parse(view.state.lastActivityAt ?? view.config.updatedAt ?? '');
  return Number.isNaN(value) ? 0 : value;
};

/** Newest life-sign first; equal timestamps preserve daemon order. */
export const byNewestActivity = (left: SessionView, right: SessionView): number => activityAt(right) - activityAt(left);

const wouldCreateCycle = (childId: string, parentId: string, parentOf: ReadonlyMap<string, string>): boolean => {
  const seen = new Set<string>([childId]);
  let current: string | undefined = parentId;
  while (current) {
    if (seen.has(current)) return true;
    seen.add(current);
    if (seen.size > parentOf.size + 1) return true;
    current = parentOf.get(current);
  }
  return false;
};

const sortAndDepth = (rows: NestedRow[], depth: number): number => {
  const subtreeActivity = new Map<NestedRow, number>();
  let newest = 0;
  for (const row of rows) {
    const childActivity = sortAndDepth(row.children, depth + 1);
    const activity = Math.max(activityAt(row.view), childActivity);
    subtreeActivity.set(row, activity);
    newest = Math.max(newest, activity);
  }
  if (depth === 0) rows.sort((left, right) => (subtreeActivity.get(right) ?? 0) - (subtreeActivity.get(left) ?? 0));
  else rows.sort((left, right) => byNewestActivity(left.view, right.view));
  for (const row of rows) row.depth = depth;
  return newest;
};

/** Nest only below visible same-group parents; hidden parents leave a clear hint. */
export const nestByLineage = (rows: readonly SessionView[], lineage: LineageIndex): NestedRow[] => {
  const visibleIds = new Set(rows.map(view => view.config.id));
  const nodes = new Map<string, NestedRow>();
  for (const view of rows) nodes.set(view.config.id, { view, depth: 0, children: [] });
  const roots: NestedRow[] = [];
  for (const view of rows) {
    const id = view.config.id;
    const node = nodes.get(id);
    if (!node) continue;
    const parent = lineage.parentOf.get(id);
    if (parent && visibleIds.has(parent) && !wouldCreateCycle(id, parent, lineage.parentOf)) {
      // `visibleIds` and `nodes` are constructed from this same `rows` array.
      const parentNode = nodes.get(parent) as NestedRow;
      parentNode.children.push(node);
      continue;
    }
    const rawParent = view.config.parent?.trim();
    if (rawParent && rawParent !== id) node.spawnedBy = rawParent;
    roots.push(node);
  }
  sortAndDepth(roots, 0);
  return roots;
};
