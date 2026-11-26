import type { RepoWorktreeRow, WorktreeRemovalDecision } from '@ferretry/core-ferrets/contract';
import type { BranchPullResult } from '@ferretry/plugin-pulls/contract';
import type { TidyWorktreeVerdict } from '../../../contract/index.ts';

const keep = (reason: string): TidyWorktreeVerdict => ({ removable: false, reason });

/** Positive evidence only. Exact head equality is a conservative proof of containment, including squash merges. */
export function worktreeVerdict(
  row: RepoWorktreeRow,
  pull: BranchPullResult | undefined,
  removal: WorktreeRemovalDecision | undefined,
): TidyWorktreeVerdict {
  if (row.main || row.bare) return keep('The main checkout cannot be tidied');
  if (row.live.detached || row.live.branch === undefined) return keep('Detached worktrees are kept');
  if (row.tracked === 'none') return keep('Adopt this worktree before tidying it');
  if (row.live.locked !== undefined) return keep('Git has locked this worktree');
  if (row.live.prunable !== undefined) return keep('The worktree is missing or prunable');
  if (row.ferrets === undefined) return keep('Could not determine which ferrets use this worktree');
  if (row.ferrets.some(ferret => ferret.active)) return keep('A live ferret is working here');
  if (pull === undefined || pull.branch !== row.live.branch || pull.outcome === 'unknown')
    return keep('Could not determine whether this branch has a merged PR');
  if (pull.outcome === 'none') return keep('No merged PR was found for this branch');
  if (pull.pull.state !== 'merged') return keep(`PR #${pull.pull.number} is ${pull.pull.state}`);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(row.live.head ?? '') || row.live.head !== pull.pull.headSha)
    return keep('The worktree head does not match the merged PR head');
  if (row.live.undetermined.length > 0) return keep(row.live.undetermined[0]!);
  const status = row.live.status;
  if (status === undefined || status.truncated) return keep('The complete worktree status could not be read');
  if (status.staged || status.unstaged || status.untracked || status.conflicted || status.dirtySubmodule)
    return keep('The worktree has uncommitted changes');
  // The existing removal path treats ignored files as content too. Never bypass it with a discard override.
  if (status.ignored) return keep('kept: ignored files present');
  if (row.live.upstream === undefined || row.live.ahead === undefined)
    return keep('Could not prove that all commits were pushed');
  if (row.live.ahead !== 0) return keep(`${row.live.ahead} commits have not been pushed`);
  if (removal === undefined) return keep('The removal safety check is unavailable');
  if (!removal.removable || removal.blockers.length > 0)
    return keep(removal.blockers[0]?.message ?? 'The removal safety check refused this worktree');
  if (removal.path !== row.path || removal.head !== row.live.head || removal.branch !== row.live.branch)
    return keep('The worktree changed during the safety check');
  return { removable: true, reason: `PR #${pull.pull.number} merged; clean, pushed and idle` };
}
