/**
 * THE SESSIONS BAR'S PARENT/CHILD TREE, as pure decisions.
 *
 * A ferret that started other ferrets (`config.parent`) is drawn with them nested beneath it, so a pack
 * reads as one thing instead of a dozen unrelated rows. The tree is built from the rows a project group
 * already lists — the filters (kind, Show stopped) have been applied to them — so a child is hidden or
 * shown by exactly the rule that hides or shows any other row.
 *
 * NOTHING DISAPPEARS. A child whose parent is not in this group's list (filtered out, stopped, or in
 * another folder) is still listed, under a faint STUB naming the parent; children of one parent share one
 * stub. A parent that does not exist at all (or a cycle) is simply a root: `buildLineage` has already
 * thrown those edges away.
 *
 * A branch's ROLLUP is what its collapsed body would have said: how many of the rows beneath it are
 * running, how many want you, how many are stopped.
 */

import type { SessionView } from '@ferretry/protocol';
import { buildLineage, lineageLabel } from '../lib/lineage.ts';
import { hasAttention, isStopped } from './sessions-bar-model.ts';

/** Indentation stops growing here: deeper rows stay in the same column rather than walking off a phone. */
export const TREE_INDENT_DEPTHS = 2;

export interface TreeRollup {
  /** Every row beneath this one. */
  readonly total: number;
  readonly running: number;
  readonly needsYou: number;
  readonly stopped: number;
}

export type TreeEntry =
  | {
      readonly kind: 'row';
      readonly view: SessionView;
      readonly depth: number;
      readonly children: readonly TreeEntry[];
      readonly rollup: TreeRollup;
    }
  | {
      readonly kind: 'stub';
      /** The absent parent's session id. */
      readonly id: string;
      readonly view: SessionView;
      readonly label: string;
      readonly depth: number;
      readonly children: readonly TreeEntry[];
      readonly rollup: TreeRollup;
    };

const NONE: TreeRollup = { total: 0, running: 0, needsYou: 0, stopped: 0 };

const add = (left: TreeRollup, right: TreeRollup): TreeRollup => ({
  total: left.total + right.total,
  running: left.running + right.running,
  needsYou: left.needsYou + right.needsYou,
  stopped: left.stopped + right.stopped,
});

/** What one row contributes to its ancestors' rollups. */
const own = (view: SessionView): TreeRollup => {
  const wants = hasAttention(view);
  return {
    total: 1,
    stopped: isStopped(view) ? 1 : 0,
    needsYou: wants ? 1 : 0,
    running: !isStopped(view) && !wants ? 1 : 0,
  };
};

interface Draft {
  readonly view: SessionView;
  readonly stub: boolean;
  readonly children: Draft[];
}

const finish = (draft: Draft, depth: number): TreeEntry => {
  const children = draft.children.map(child => finish(child, depth + 1));
  const rollup = children.reduce((sum, child) => add(sum, add(own(child.view), child.rollup)), NONE);
  return draft.stub
    ? {
        kind: 'stub',
        id: draft.view.config.id,
        view: draft.view,
        label: lineageLabel(draft.view).text,
        depth,
        children,
        rollup,
      }
    : { kind: 'row', view: draft.view, depth, children, rollup };
};

/**
 * One group's tree. `rows` keep the order they arrive in (the bar sorts them by activity), `universe` is
 * every session the machine has, so a hidden parent can still be named.
 */
export const sessionTree = (rows: readonly SessionView[], universe: readonly SessionView[]): readonly TreeEntry[] => {
  const lineage = buildLineage(universe);
  const byId = new Map(universe.map(view => [view.config.id, view] as const));
  const drafts = new Map<string, Draft>(
    rows.map(view => [view.config.id, { view, stub: false, children: [] }] as const),
  );
  const stubs = new Map<string, Draft>();
  const roots: Draft[] = [];
  for (const view of rows) {
    const draft = drafts.get(view.config.id) as Draft;
    const parentId = lineage.parentOf.get(view.config.id);
    const visible = parentId === undefined ? undefined : drafts.get(parentId);
    if (visible !== undefined) {
      visible.children.push(draft);
      continue;
    }
    const absent = parentId === undefined ? undefined : byId.get(parentId);
    if (parentId === undefined || absent === undefined) {
      roots.push(draft);
      continue;
    }
    let stub = stubs.get(parentId);
    if (stub === undefined) {
      stub = { view: absent, stub: true, children: [] };
      stubs.set(parentId, stub);
      roots.push(stub);
    }
    stub.children.push(draft);
  }
  return roots.map(root => finish(root, 0));
};

/** The rollup said as words: `3 running · 1 needs you`. Empty when there is nothing beneath. */
export const rollupWords = (rollup: TreeRollup): string =>
  [
    rollup.needsYou > 0 ? `${rollup.needsYou} needs you` : '',
    rollup.running > 0 ? `${rollup.running} running` : '',
    rollup.stopped > 0 ? `${rollup.stopped} stopped` : '',
  ]
    .filter(Boolean)
    .join(' · ');

/** `1 sub-ferret`, `3 sub-ferrets`. */
export const subFerretCount = (count: number): string => `${count} sub-ferret${count === 1 ? '' : 's'}`;

/** True when this entry or anything beneath it is the open session. */
export const containsSession = (entry: TreeEntry, sessionId: string | null): boolean =>
  sessionId !== null &&
  ((entry.kind === 'row' && entry.view.config.id === sessionId) ||
    entry.children.some(child => containsSession(child, sessionId)));
