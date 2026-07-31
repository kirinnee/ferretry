import type { SessionView } from '@ferretry/protocol';
import type { BulkStopSelector, StopPlan, StopTarget } from './types.ts';

/**
 * The four settled terminal states have no live work left to end. `kill_failed` deliberately stays
 * stoppable because another stop is its recovery path.
 */
const UNSTOPPABLE = new Set(['completed', 'failed', 'stalled', 'stopped']);

export function isStoppable(view: SessionView): boolean {
  return !UNSTOPPABLE.has(view.state.status);
}

function normalizeParent(view: SessionView): string | undefined {
  const parent = view.config.parent?.trim();
  return parent ? parent : undefined;
}

function sessionMap(sessions: readonly SessionView[]): Map<string, SessionView> {
  const byId = new Map<string, SessionView>();
  for (const view of sessions) {
    const id = view.config.id.trim();
    if (id && !byId.has(id)) byId.set(id, view);
  }
  return byId;
}

/**
 * The caller's ancestors are the best locally knowable lead chain: stopping one of them very likely
 * kills the session that is supervising this work, so the plan flags them loudly.
 */
export function callerAncestorIds(sessions: readonly SessionView[], callerId?: string): Set<string> {
  const ancestors = new Set<string>();
  const normalizedCaller = callerId?.trim();
  if (!normalizedCaller) return ancestors;
  const byId = sessionMap(sessions);
  const seen = new Set<string>([normalizedCaller]);
  const caller = byId.get(normalizedCaller);
  let current = caller ? normalizeParent(caller) : undefined;
  while (current && !seen.has(current)) {
    ancestors.add(current);
    seen.add(current);
    const view = byId.get(current);
    current = view ? normalizeParent(view) : undefined;
  }
  return ancestors;
}

/** Breadth-first subtree walk. The visited set makes a malformed parent cycle terminate. */
function subtreeDepths(byId: ReadonlyMap<string, SessionView>, rootId: string): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const view of byId.values()) {
    const parent = normalizeParent(view);
    const childId = view.config.id.trim();
    if (!parent || !childId) continue;
    const existing = children.get(parent);
    if (existing) existing.push(childId);
    else children.set(parent, [childId]);
  }

  const depth = new Map<string, number>();
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  for (let index = 0; index < queue.length; index += 1) {
    const next = queue[index]!;
    if (depth.has(next.id)) continue;
    depth.set(next.id, next.depth);
    for (const child of children.get(next.id) ?? []) {
      if (!depth.has(child)) queue.push({ id: child, depth: next.depth + 1 });
    }
  }
  return depth;
}

/** How deep a session sits in the whole fleet, used to order label selections sensibly. */
function lineageDepth(byId: ReadonlyMap<string, SessionView>, id: string): number {
  let depth = 0;
  let current = byId.get(id);
  const seen = new Set<string>([id]);
  while (current) {
    const parent = normalizeParent(current);
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    depth += 1;
    current = byId.get(parent);
  }
  return depth;
}

function targetFrom(
  view: SessionView,
  depth: number,
  callerId: string | undefined,
  ancestors: ReadonlySet<string>,
): StopTarget {
  const id = view.config.id.trim();
  const parent = normalizeParent(view);
  const label = view.config.label?.trim();
  return {
    id,
    name: view.config.name || id,
    ...(view.config.teammate ? { teammate: view.config.teammate } : {}),
    ...(label ? { label } : {}),
    ...(parent ? { parent } : {}),
    status: view.state.status,
    depth,
    caller: id === callerId?.trim(),
    callerAncestor: ancestors.has(id),
  };
}

/**
 * Stop parents before children so each confirmed spawn source closes as early as possible. The
 * caller, when explicitly included, is the sole exception: it goes last so the CLI can report every
 * other outcome before its own pane may disappear.
 */
function compareTargets(a: StopTarget, b: StopTarget): number {
  if (a.caller !== b.caller) return a.caller ? 1 : -1;
  return compareLineage(a, b);
}

function compareLineage(a: StopTarget, b: StopTarget): number {
  if (a.depth !== b.depth) return a.depth - b.depth;
  return (a.teammate ?? a.name).localeCompare(b.teammate ?? b.name) || a.id.localeCompare(b.id);
}

/** Raised when a selector cannot describe any set of sessions at all. */
export class StopSelectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StopSelectorError';
  }
}

/**
 * Reconstruct the selected set from session records. Both the subtree walk and the caller-ancestor
 * walk carry visited sets, so malformed parent cycles cannot recurse forever.
 */
export function buildStopPlan(
  sessions: readonly SessionView[],
  selector: BulkStopSelector,
  options: { callerId?: string; includeCaller?: boolean } = {},
): StopPlan {
  const byId = sessionMap(sessions);
  const ancestors = callerAncestorIds(sessions, options.callerId);
  const selected: StopTarget[] = [];
  const leftRunning: StopTarget[] = [];

  if (selector.kind === 'label') {
    const label = selector.label.trim();
    if (!label) throw new StopSelectorError('label must not be empty');
    for (const view of byId.values()) {
      // Both sides are trimmed: a stored label with stray whitespace used to match nothing at all.
      if (view.config.label?.trim() !== label || !isStoppable(view)) continue;
      selected.push(targetFrom(view, lineageDepth(byId, view.config.id.trim()), options.callerId, ancestors));
    }
  } else {
    const rootId = selector.rootId.trim();
    if (!rootId) throw new StopSelectorError('session id must not be empty');
    for (const [id, itemDepth] of subtreeDepths(byId, rootId)) {
      const view = byId.get(id);
      if (!view || !isStoppable(view)) continue;
      const target = targetFrom(view, itemDepth, options.callerId, ancestors);
      if (selector.kind === 'orphan') {
        if (id === rootId) selected.push(target);
        else leftRunning.push(target);
      } else if (selector.kind === 'children') {
        if (id !== rootId) selected.push(target);
      } else {
        selected.push(target);
      }
    }
  }

  selected.sort(compareTargets);
  leftRunning.sort(compareLineage);
  const excluded = options.includeCaller ? [] : selected.filter(target => target.caller);
  const targets = options.includeCaller ? selected : selected.filter(target => !target.caller);
  return {
    selector,
    candidates: selected,
    targets,
    excluded,
    leftRunning,
    ...(options.callerId ? { callerId: options.callerId } : {}),
  };
}
