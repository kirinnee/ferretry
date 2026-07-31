import type { UnclearedBlocker } from './overrides.ts';
import type { ManagedWorktreeView, RemovedWorktree, WorktreeListResponse, WorktreeRemovalDecision } from './wire.ts';

const INDENT = '    ';

const plural = (count: number, singular: string): string => `${count} ${count === 1 ? singular : `${singular}s`}`;

/** Who is working in a worktree right now, which is the first thing that makes removal unsafe. */
function occupancy(worktree: ManagedWorktreeView): string {
  const owner = worktree.ownerSessionId === undefined ? 'no owner' : `owner ${worktree.ownerSessionId}`;
  const state = worktree.ownerActive ? 'active' : 'ended';
  const shared = worktree.sharedWith.length === 0 ? '' : ` · shared with ${worktree.sharedWith.join(', ')}`;
  return `${owner} (${state})${shared}`;
}

/** One worktree as a list row. */
export function renderWorktreeRow(worktree: ManagedWorktreeView): string {
  const lines = [
    `  ${worktree.path}`,
    `${INDENT}branch ${worktree.branch}${worktree.branchPreexisted ? ' (pre-existing)' : ''} · created ${worktree.createdAt}`,
    `${INDENT}${occupancy(worktree)}`,
  ];
  if (worktree.removedAt !== undefined) lines.push(`${INDENT}removed ${worktree.removedAt}`);
  return lines.join('\n');
}

/**
 * The managed worktrees, live ones first.
 *
 * A worktree with a `removedAt` is a tombstone the daemon keeps for provenance; showing it beside a
 * live one, as kteam did, made a removed checkout look like something still on disk.
 */
export function renderWorktreeList(response: WorktreeListResponse): string {
  const live = response.worktrees.filter(worktree => worktree.removedAt === undefined);
  const removed = response.worktrees.filter(worktree => worktree.removedAt !== undefined);
  const root = response.managedRoot === undefined ? '' : ` under ${response.managedRoot}`;
  if (live.length === 0 && removed.length === 0) return `No managed worktrees${root}.`;

  const sections: string[] = [];
  if (live.length === 0) sections.push(`No live managed worktrees${root}.`);
  else sections.push(`${plural(live.length, 'managed worktree')}${root}`, ...live.map(renderWorktreeRow));
  if (removed.length > 0)
    sections.push(`${plural(removed.length, 'removed worktree')} still recorded`, ...removed.map(renderWorktreeRow));
  return sections.join('\n');
}

/** One blocker, naming the flag that would clear it, or saying plainly that nothing does. */
export function renderBlocker(blocker: UnclearedBlocker): string {
  const remedy = blocker.flag === undefined ? 'nothing overrides this' : `pass ${blocker.flag} to accept it`;
  return `  ✗ ${blocker.code}: ${blocker.message} — ${remedy}`;
}

/** The removal verdict: safe, or blocked by these named things. */
export function renderRemovalDecision(
  decision: WorktreeRemovalDecision,
  uncleared: readonly UnclearedBlocker[],
): string {
  const header = `${decision.path} (branch ${decision.branch}${decision.upstream === undefined ? ', no upstream' : ` → ${decision.upstream}`})`;
  if (uncleared.length === 0) return [header, '  ✓ safe to remove'].join('\n');
  return [header, `  ${plural(uncleared.length, 'blocker')}:`, ...uncleared.map(renderBlocker)].join('\n');
}

/** Confirmation for a removal, stating whether the branch outlived the worktree. */
export function renderRemoved(removed: RemovedWorktree): string {
  const branch = removed.branchRetained ? `branch ${removed.branch} kept` : `branch ${removed.branch} deleted`;
  return `removed ${removed.path} at ${removed.removedAt} — ${branch}`;
}
