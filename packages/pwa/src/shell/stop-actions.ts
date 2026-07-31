/**
 * THE FOUR EXPLICIT FLEET STOP SCOPES. Ported from kteam
 * `ui/src/lib/stop-actions.ts`.
 *
 * They deliberately mirror the CLI: lineage (orphan / cascade / children) and
 * labels are INDEPENDENT selectors and are never combined. The opaque
 * one-session "Stop" the sidebar used to offer is gone — a person stopping a
 * lead has to say what should happen to everything it spawned.
 *
 * Parent links are untrusted input. Every traversal here records visited ids and
 * stays finite for an accidental self-parent or a longer cycle, because the
 * alternative is a hung tab on malformed fleet data.
 *
 * Source order is retained wherever depth does not decide, so a confirmation
 * list is stable and easy to compare against the fleet the reader is looking at.
 *
 * Daemon scope: every function takes the session list it should consider. There
 * is no store, no cache and no ambient fleet, so one daemon's sessions can never
 * become another's stop targets — see `session-actions.ts` for the same
 * treatment of survey row #4.
 */

import type { SessionView } from '@ferretry/protocol';
import { sessionActionSpecs } from './session-actions.ts';

export type StopScope = 'orphan' | 'cascade' | 'children' | 'label';

/**
 * A session can participate in a bulk stop exactly when the row UI offers its
 * retry-safe Stop action — including `kill_failed`, excluding other terminals.
 * Asking `sessionActionSpecs` rather than re-listing statuses is what keeps the
 * sweep and the menu from disagreeing.
 */
export const isStoppable = (view: SessionView): boolean =>
  sessionActionSpecs(view, true).some(spec => spec.action === 'stop');

/** Ids reachable downward from `selectedId`, cycle-safe. */
const descendantIds = (
  sessions: readonly SessionView[],
  selectedId: string,
  includeSelected: boolean,
): ReadonlySet<string> => {
  const childIds = new Map<string, string[]>();
  for (const view of sessions) {
    const parent = view.config.parent?.trim();
    if (!parent) continue;
    const children = childIds.get(parent) ?? [];
    children.push(view.config.id);
    childIds.set(parent, children);
  }

  const ids = new Set<string>();
  const queue = includeSelected ? [selectedId] : [...(childIds.get(selectedId) ?? [])];
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    if (ids.has(id)) continue;
    ids.add(id);
    queue.push(...(childIds.get(id) ?? []));
  }
  return ids;
};

/**
 * Sort confirmed parents before their descendants. Closing the shallowest
 * spawners first minimizes the window in which they can create more children.
 */
const shallowestFirst = (sessions: readonly SessionView[], targets: readonly SessionView[]): SessionView[] => {
  const byId = new Map(sessions.map(view => [view.config.id, view]));
  const depth = (view: SessionView): number => {
    const seen = new Set<string>([view.config.id]);
    let parent = view.config.parent?.trim();
    let result = 0;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      result++;
      parent = byId.get(parent)?.config.parent?.trim();
    }
    return result;
  };
  return targets
    .map((view, index) => ({ view, index, depth: depth(view) }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map(item => item.view);
};

/**
 * Live descendants are NOT stop targets in orphan mode: they are the exact
 * sessions a person is consciously leaving running after their parent stops,
 * which is why the confirmation leads with them rather than hiding them.
 */
export const selectLiveDescendants = (sessions: readonly SessionView[], selectedId: string): readonly SessionView[] => {
  const selected = sessions.find(view => view.config.id === selectedId);
  if (!selected) return [];
  const ids = descendantIds(sessions, selectedId, false);
  return shallowestFirst(
    sessions,
    sessions.filter(view => view.config.id !== selectedId && ids.has(view.config.id) && isStoppable(view)),
  );
};

/** The currently eligible targets for one explicit stop scope. */
export const selectStopTargets = (
  sessions: readonly SessionView[],
  selectedId: string,
  scope: StopScope,
): readonly SessionView[] => {
  const selected = sessions.find(view => view.config.id === selectedId);
  if (!selected) return [];

  if (scope === 'label') {
    const label = selected.config.label;
    if (!label?.trim()) return [];
    return shallowestFirst(
      sessions,
      sessions.filter(view => view.config.label === label && isStoppable(view)),
    );
  }

  // Orphan has one deliberately narrow target; it must not traverse a malformed
  // descendant graph merely to decide that fact.
  if (scope === 'orphan') return isStoppable(selected) ? [selected] : [];

  const ids = descendantIds(sessions, selectedId, scope !== 'children');
  const targets = sessions.filter(
    view => !(scope === 'children' && view.config.id === selectedId) && ids.has(view.config.id) && isStoppable(view),
  );
  return shallowestFirst(sessions, targets);
};

export const stopScopeLabel = (scope: StopScope): string => {
  switch (scope) {
    case 'orphan':
      return 'Stop · orphan this session';
    case 'cascade':
      return 'Stop · cascade whole tree';
    case 'children':
      return 'Stop · children only (keep this)';
    case 'label':
      return 'Stop · label';
  }
};

/**
 * One explicit reason is carried to every per-session stop request in a
 * confirmed sweep, so daemon history explains why a session stopped rather than
 * recording an unattributed kill.
 */
export const stopScopeReason = (scope: StopScope, selection: string): string => {
  switch (scope) {
    case 'orphan':
      return `stopped orphan ${selection} from browser`;
    case 'cascade':
      return `stopped cascade ${selection} from browser`;
    case 'children':
      return `stopped children of ${selection} from browser`;
    case 'label':
      return `stopped label ${selection} from browser`;
  }
};
