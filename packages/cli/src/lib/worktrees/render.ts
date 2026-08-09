import type {
  BranchDeletionConfirmation,
  CreatedWorktree,
  ManagedWorktreeView,
  RemovedWorktree,
  WorktreeListResponse,
  WorktreeLiveState,
  WorktreeRemovalDecision,
} from '@ferretry/protocol';
import type { UnclearedBlocker } from './overrides.ts';

const INDENT = '    ';

const plural = (count: number, singular: string): string => `${count} ${count === 1 ? singular : `${singular}s`}`;

/** Who is working in a worktree right now, which is the first thing that makes removal unsafe. */
function occupancy(worktree: ManagedWorktreeView): string {
  const owner = worktree.ownerSessionId === undefined ? 'no owner' : `owner ${worktree.ownerSessionId}`;
  const state = worktree.ownerActive ? 'active' : 'ended';
  const shared = worktree.sharedWith.length === 0 ? '' : ` · shared with ${worktree.sharedWith.join(', ')}`;
  return `${owner} (${state})${shared}`;
}

/** What the checkout's content looks like, as words rather than as a count of nothing. */
function content(live: WorktreeLiveState): string {
  const status = live.status;
  if (status === undefined) return 'content unknown';
  const marks = [
    status.staged ? 'staged' : '',
    status.unstaged ? 'unstaged' : '',
    status.untracked ? 'untracked' : '',
    status.ignored ? 'ignored' : '',
    status.conflicted ? 'conflicted' : '',
    status.dirtySubmodule ? 'dirty submodule' : '',
  ].filter(mark => mark !== '');
  return marks.length === 0 ? 'clean' : marks.join(', ');
}

/**
 * How far the branch is from where it is published.
 *
 * An unknown count is SAID rather than shown as zero. "0 ahead" and "nobody could tell me" are
 * different facts, and printing the first for the second is how somebody deletes unpushed work.
 */
function tracking(live: WorktreeLiveState): string {
  if (live.upstream === undefined) return 'no upstream';
  if (live.ahead === undefined || live.behind === undefined) return `${live.upstream} · divergence unknown`;
  return `${live.upstream} · ${live.ahead} ahead, ${live.behind} behind`;
}

/** The live lines: where the checkout actually is now, and whether it may go. */
function liveLines(worktree: ManagedWorktreeView): readonly string[] {
  const live = worktree.live;
  if (live === undefined) return [];
  const head = live.head === undefined ? 'HEAD unknown' : `HEAD ${live.head.slice(0, 12)}`;
  const on = live.detached ? 'detached' : `on ${live.branch ?? 'an unreadable branch'}`;
  const marks = [
    live.locked === undefined ? '' : `locked${live.locked === '' ? '' : ` (${live.locked})`}`,
    live.prunable === undefined ? '' : 'prunable',
    live.integrated === undefined ? 'integration unproven' : live.integrated ? 'integrated' : 'not integrated',
  ].filter(mark => mark !== '');
  const safety =
    worktree.removal === undefined
      ? 'removal unassessed'
      : worktree.removal.removable
        ? 'safe to remove'
        : plural(worktree.removal.blockers.length, 'blocker');
  return [
    `${INDENT}${head} · ${on} · ${content(live)}`,
    `${INDENT}${tracking(live)} · ${[...marks, safety].join(' · ')}`,
    ...live.undetermined.map(reason => `${INDENT}? ${reason}`),
  ];
}

/** One worktree as a list row. */
export function renderWorktreeRow(worktree: ManagedWorktreeView): string {
  const lines = [
    `  ${worktree.path}`,
    `${INDENT}branch ${worktree.branch}${worktree.branchPreexisted ? ' (pre-existing)' : ''} · created ${worktree.createdAt}`,
    `${INDENT}${occupancy(worktree)}${worktree.projectId === undefined ? '' : ` · project ${worktree.projectId}`}`,
    ...(worktree.unresolved === undefined ? [] : [`${INDENT}! unfinished: ${worktree.unresolved}`]),
    ...liveLines(worktree),
  ];
  if (worktree.removedAt !== undefined) lines.push(`${INDENT}removed ${worktree.removedAt}`);
  return lines.join('\n');
}

/**
 * The managed worktrees, live ones first.
 *
 * A worktree with a `removedAt` is a tombstone the daemon keeps for provenance; showing it beside a
 * live one made a removed checkout look like something still on disk.
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

/**
 * What deleting the branch as well would cost, when the daemon could price it.
 *
 * Printed on the CHECK so the answer arrives before the authorization, which is the ordering this
 * whole group is built around: say what would be lost, then ask.
 */
const BRANCH_CONFIRMATION_FLAGS: Readonly<Record<BranchDeletionConfirmation, string>> = {
  delete_preexisting_branch: '--delete-branch --delete-preexisting',
  delete_unpushed_branch: '--delete-branch --accept-unpushed',
  delete_unmerged_branch: '--delete-branch --delete-unmerged',
};

function branchLines(
  decision: WorktreeRemovalDecision,
  confirmations: readonly BranchDeletionConfirmation[],
): readonly string[] {
  const branch = decision.branchDeletion;
  if (branch === undefined) return ['  branch deletion could not be assessed'];
  const granted = new Set(confirmations);
  const blockers = branch.blockers.filter(
    blocker => blocker.confirmation === undefined || !granted.has(blocker.confirmation),
  );
  if (blockers.length === 0) return [`  branch ${decision.branch} can be deleted with it`];
  return [
    `  branch ${decision.branch} would be kept:`,
    ...blockers.map(
      blocker =>
        `    ✗ ${blocker.code}: ${blocker.message} — ${
          blocker.confirmation === undefined
            ? 'nothing confirms this'
            : `confirm with ${BRANCH_CONFIRMATION_FLAGS[blocker.confirmation]}`
        }`,
    ),
  ];
}

/** The removal verdict: safe, or blocked by these named things. */
export function renderRemovalDecision(
  decision: WorktreeRemovalDecision,
  uncleared: readonly UnclearedBlocker[],
  confirmations: readonly BranchDeletionConfirmation[] = [],
): string {
  const header = `${decision.path} (branch ${decision.branch}${decision.upstream === undefined ? ', no upstream' : ` → ${decision.upstream}`})`;
  const verdict =
    uncleared.length === 0
      ? ['  ✓ safe to remove']
      : [`  ${plural(uncleared.length, 'blocker')}:`, ...uncleared.map(renderBlocker)];
  return [header, ...verdict, ...branchLines(decision, confirmations)].join('\n');
}

/** Confirmation for a removal, stating whether the branch outlived the worktree and why. */
export function renderRemoved(removed: RemovedWorktree): string {
  const branch = removed.branchRetained ? `branch ${removed.branch} kept` : `branch ${removed.branch} deleted`;
  return [
    `removed ${removed.path} at ${removed.removedAt} — ${branch}`,
    ...removed.branchBlockers.map(blocker => `  ✗ ${blocker.code}: ${blocker.message}`),
  ].join('\n');
}

/** Confirmation for a fork: where the checkout is, and the directory to start work in. */
export function renderCreated(created: CreatedWorktree): string {
  return [
    `created ${created.worktree.path} on branch ${created.worktree.branch}`,
    `${INDENT}from ${created.worktree.initialHead.slice(0, 12)} · start work in ${created.cwd}`,
  ].join('\n');
}
