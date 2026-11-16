import type { FerretSummary as SessionView } from '../../../contract/index.ts';
import { parentOf, sessionsById, subtreeDepths } from './lineage.ts';
import type { BulkStopSelector, StopPlan, StopTarget } from './types.ts';

/** Every ferret that is not stopped can be stopped (again, if its last stop did not take). */
export function isStoppable(view: SessionView): boolean {
  return view.state !== 'stopped';
}

/**
 * The caller's ancestors are the best locally knowable lead chain: stopping one of them very likely
 * kills the session that is supervising this work, so the plan flags them loudly.
 */
export function callerAncestorIds(sessions: readonly SessionView[], callerId?: string): Set<string> {
  const ancestors = new Set<string>();
  const normalizedCaller = callerId?.trim();
  if (!normalizedCaller) return ancestors;
  const byId = sessionsById(sessions);
  const seen = new Set<string>([normalizedCaller]);
  const caller = byId.get(normalizedCaller);
  let current = caller ? parentOf(caller) : undefined;
  while (current && !seen.has(current)) {
    ancestors.add(current);
    seen.add(current);
    const view = byId.get(current);
    current = view ? parentOf(view) : undefined;
  }
  return ancestors;
}

/** How deep a session sits in the whole fleet, used to order label selections sensibly. */
function lineageDepth(byId: ReadonlyMap<string, SessionView>, id: string): number {
  let depth = 0;
  let current = byId.get(id);
  const seen = new Set<string>([id]);
  while (current) {
    const parent = parentOf(current);
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
  const id = view.id.trim();
  const parent = parentOf(view);
  const label = view.label?.trim();
  return {
    id,
    name: view.name || id,
    ...(label ? { label } : {}),
    ...(parent ? { parent } : {}),
    status: view.state,
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
  const byId = sessionsById(sessions);
  const ancestors = callerAncestorIds(sessions, options.callerId);
  const selected: StopTarget[] = [];
  const leftRunning: StopTarget[] = [];

  if (selector.kind === 'label') {
    const label = selector.label.trim();
    if (!label) throw new StopSelectorError('label must not be empty');
    for (const view of byId.values()) {
      // Both sides are trimmed: a stored label with stray whitespace used to match nothing at all.
      if (view.label?.trim() !== label || !isStoppable(view)) continue;
      selected.push(targetFrom(view, lineageDepth(byId, view.id.trim()), options.callerId, ancestors));
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
