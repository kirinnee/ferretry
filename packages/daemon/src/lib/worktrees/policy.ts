import path from 'node:path';
import type {
  BranchDeletionBlocker,
  BranchDeletionConfirmation,
  BranchDeletionDecision,
  BranchDeletionEvidence,
  WorktreeRemovalBlocker,
  WorktreeRemovalBlockerCode,
  WorktreeRemovalDecision,
  WorktreeRemovalEvidence,
  WorktreeRemovalOverride,
  WorktreeStatusSummary,
} from './types.ts';

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function isCurrentCheckout(target: string, currentWorkingDirectory: string | undefined): boolean {
  return currentWorkingDirectory !== undefined && isPathInside(target, currentWorkingDirectory);
}

export function sharingSessionIds(
  target: string,
  sessions: readonly { readonly id: string; readonly cwd: string }[],
): readonly string[] {
  return sessions.filter(session => isPathInside(target, session.cwd)).map(session => session.id);
}

export function isCheckoutLocked(locked: string | undefined): boolean {
  return locked !== undefined;
}

export function hasDirtyWorktree(status: WorktreeStatusSummary): boolean {
  return (
    status.staged ||
    status.unstaged ||
    status.untracked ||
    status.ignored ||
    status.conflicted ||
    status.dirtySubmodule ||
    status.truncated
  );
}

export function requiredRemovalOverride(code: WorktreeRemovalBlockerCode): WorktreeRemovalOverride | undefined {
  if (
    code === 'staged_changes' ||
    code === 'unstaged_changes' ||
    code === 'untracked_content' ||
    code === 'ignored_content' ||
    code === 'conflicted_worktree' ||
    code === 'dirty_submodule'
  ) {
    return 'discard_worktree_changes';
  }
  if (code === 'unpushed_commits') return 'accept_unpushed_commits';
  return undefined;
}

function blocker(code: WorktreeRemovalBlockerCode, message: string): WorktreeRemovalBlocker {
  const override = requiredRemovalOverride(code);
  return { code, message, ...(override === undefined ? {} : { override }) };
}

export function assessWorktreeRemoval(evidence: WorktreeRemovalEvidence): WorktreeRemovalDecision {
  const blockers: WorktreeRemovalBlocker[] = [];
  const recordedPath = path.resolve(evidence.recordedPath);
  const resolvedRoot = path.resolve(evidence.resolvedManagedRoot);
  const resolvedPath = evidence.resolvedPath === undefined ? undefined : path.resolve(evidence.resolvedPath);

  if (evidence.ownerActive) blockers.push(blocker('active_session', 'the owning session is still active'));
  if (!isPathInside(resolvedRoot, recordedPath)) {
    blockers.push(blocker('outside_managed_root', 'the recorded checkout is outside the managed root'));
  }
  if (resolvedPath === undefined) {
    blockers.push(blocker('missing_worktree', 'the recorded checkout no longer exists'));
  } else {
    if (!isPathInside(resolvedRoot, resolvedPath)) {
      blockers.push(blocker('outside_managed_root', 'the checkout resolves outside the managed root'));
    }
    if (resolvedPath !== recordedPath) {
      blockers.push(blocker('path_identity_mismatch', 'the checkout resolves to a different path'));
    }
    if (isCurrentCheckout(resolvedPath, evidence.currentWorkingDirectory)) {
      blockers.push(blocker('current_checkout', "the checkout is the caller's current working directory"));
    }
    const shared = sharingSessionIds(resolvedPath, evidence.otherSessions);
    if (shared.length > 0) {
      blockers.push(blocker('shared_checkout', `the checkout is still referenced by ${shared.join(', ')}`));
    }
  }
  if (evidence.liveTerminals > 0) {
    blockers.push(blocker('live_terminal', `${evidence.liveTerminals} live terminal(s) still use the checkout`));
  }
  if (!evidence.ownershipMarkerMatches) {
    blockers.push(blocker('ownership_mismatch', 'the checkout ownership marker is missing or does not match'));
  }

  const checkout = evidence.checkout;
  if (checkout !== undefined) {
    if (checkout.kind === 'main_checkout') {
      blockers.push(blocker('main_checkout', 'the primary checkout cannot be removed as a managed worktree'));
    }
    if (
      !checkout.repo ||
      checkout.kind !== 'linked_worktree' ||
      checkout.repositoryRoot !== evidence.expectedRepositoryRoot ||
      checkout.commonDir !== evidence.expectedCommonDir ||
      checkout.gitDir !== evidence.expectedGitDir
    ) {
      blockers.push(blocker('repository_mismatch', 'the checkout no longer matches the managed repository identity'));
    }
    if (checkout.detached || checkout.branch !== evidence.expectedBranch) {
      blockers.push(blocker('branch_mismatch', 'the checkout is no longer on its managed branch'));
    }
    if (isCheckoutLocked(checkout.locked)) {
      blockers.push(blocker('locked_worktree', 'Git has locked the checkout'));
    }
  }

  const status = evidence.status;
  if (status !== undefined) {
    if (status.staged) blockers.push(blocker('staged_changes', 'the checkout has staged changes'));
    if (status.unstaged) blockers.push(blocker('unstaged_changes', 'the checkout has unstaged changes'));
    if (status.untracked) blockers.push(blocker('untracked_content', 'the checkout has untracked content'));
    if (status.ignored) blockers.push(blocker('ignored_content', 'the checkout has ignored content'));
    if (status.conflicted) blockers.push(blocker('conflicted_worktree', 'the checkout has unresolved conflicts'));
    if (status.dirtySubmodule) blockers.push(blocker('dirty_submodule', 'the checkout has a dirty submodule'));
    if (status.truncated) blockers.push(blocker('git_error', 'Git status output was truncated'));
  }

  const pushState = evidence.pushState;
  if (pushState?.kind === 'unpushed') blockers.push(blocker('unpushed_commits', pushState.reason));
  if (pushState?.kind === 'unknown') blockers.push(blocker('git_error', pushState.reason));
  for (const message of evidence.gitErrors) blockers.push(blocker('git_error', message));

  return {
    removable: blockers.length === 0,
    path: recordedPath,
    branch: evidence.expectedBranch,
    head: checkout?.head,
    upstream: pushState?.kind === 'unknown' ? undefined : pushState?.upstream,
    blockers,
  };
}

function branchBlocker(
  code: BranchDeletionBlocker['code'],
  message: string,
  confirmation?: BranchDeletionConfirmation,
): BranchDeletionBlocker {
  return { code, message, ...(confirmation === undefined ? {} : { confirmation }) };
}

export function assessBranchDeletion(
  evidence: BranchDeletionEvidence,
  confirmations: readonly BranchDeletionConfirmation[] = [],
): BranchDeletionDecision {
  const blockers: BranchDeletionBlocker[] = [];
  if (evidence.protectedBranch)
    blockers.push(branchBlocker('protected_branch', 'the protected branch cannot be deleted'));
  if (evidence.checkedOut) blockers.push(branchBlocker('branch_checked_out', 'the branch is still checked out'));
  if (evidence.activeCheckout)
    blockers.push(branchBlocker('active_checkout', 'an active session still owns the branch'));
  if (evidence.liveTerminals > 0)
    blockers.push(branchBlocker('live_terminal', 'a live terminal still uses the branch'));
  if (evidence.branchPreexisted) {
    blockers.push(
      branchBlocker('preexisting_branch', 'the branch existed before management', 'delete_preexisting_branch'),
    );
  }
  if (!evidence.commitsPushed) {
    blockers.push(branchBlocker('unpushed_commits', 'the branch has unpushed commits', 'delete_unpushed_branch'));
  }
  if (!evidence.integrated) {
    blockers.push(branchBlocker('unmerged_branch', 'the branch is not integrated', 'delete_unmerged_branch'));
  }

  const deletable = blockers.every(
    item => item.confirmation !== undefined && confirmations.includes(item.confirmation),
  );
  return { deletable, blockers };
}
