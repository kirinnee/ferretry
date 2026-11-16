import type { FerretSummary } from '../../../contract/index.ts';

/** The ferret's parent, trimmed; a blank one is none. */
export function parentOf(view: FerretSummary): string | undefined {
  const parent = view.parent?.trim();
  return parent ? parent : undefined;
}

/** Ferrets keyed by their trimmed id; the first record of a repeated id wins. */
export function sessionsById(sessions: readonly FerretSummary[]): Map<string, FerretSummary> {
  const byId = new Map<string, FerretSummary>();
  for (const view of sessions) {
    const id = view.id.trim();
    if (id && !byId.has(id)) byId.set(id, view);
  }
  return byId;
}

/**
 * Breadth-first subtree walk: every ferret at or under `rootId`, with how deep it sits (the root is 0). The visited
 * set makes a malformed parent cycle terminate.
 */
export function subtreeDepths(byId: ReadonlyMap<string, FerretSummary>, rootId: string): Map<string, number> {
  const children = new Map<string, string[]>();
  for (const view of byId.values()) {
    const parent = parentOf(view);
    const childId = view.id.trim();
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
