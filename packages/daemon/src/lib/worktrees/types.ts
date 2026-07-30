export type GitCheckoutKind = 'main_checkout' | 'linked_worktree' | 'not_git' | 'missing';

export interface GitCheckoutSnapshot {
  readonly repo: boolean;
  readonly kind: GitCheckoutKind;
  readonly worktreeRoot?: string;
  readonly repositoryRoot?: string;
  readonly gitDir?: string;
  readonly commonDir?: string;
  readonly branch?: string;
  readonly detached?: boolean;
  readonly head?: string;
  readonly locked?: string;
  readonly prunable?: string;
  readonly observedAt: string;
}

export interface WorktreeListEntry {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked?: string;
  readonly prunable?: string;
}

export interface ManagedWorktree {
  readonly version: 1;
  readonly path: string;
  readonly branch: string;
  readonly repositoryRoot: string;
  readonly commonDir: string;
  readonly gitDir: string;
  readonly ownershipToken: string;
  readonly createdAt: string;
  readonly initialHead: string;
  readonly branchPreexisted: boolean;
  readonly removedAt?: string;
}

export interface ManagedWorktreePlan {
  readonly sourceCwd: string;
  readonly path: string;
  readonly sessionCwd: string;
  readonly branch: string;
  readonly repositoryRoot: string;
  readonly commonDir: string;
  readonly ownershipToken: string;
  readonly branchPreexisted: boolean;
  readonly startOid: string;
  readonly trackingRef?: string;
}

export interface CreatedManagedWorktree {
  readonly cwd: string;
  readonly checkout: GitCheckoutSnapshot;
  readonly managed: ManagedWorktree;
}

export interface CreateManagedWorktreeInput {
  readonly sourceCwd: string;
  readonly branch: string;
  readonly sessionId: string;
  readonly ownershipToken: string;
  readonly managedRoot: string;
  readonly startPoint?: string;
  readonly timeoutMs?: number;
  readonly onPlanned?: (plan: ManagedWorktreePlan) => Promise<void>;
}

export interface WorktreeStatusSummary {
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly untracked: boolean;
  readonly ignored: boolean;
  readonly conflicted: boolean;
  readonly dirtySubmodule: boolean;
  readonly truncated: boolean;
}

export type WorktreePushState =
  | { readonly kind: 'pushed'; readonly upstream?: string }
  | { readonly kind: 'unpushed'; readonly upstream?: string; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string };

export type WorktreeRemovalOverride = 'discard_worktree_changes' | 'accept_unpushed_commits' | 'delete_unmerged_branch';

export type WorktreeRemovalBlockerCode =
  | 'active_session'
  | 'current_checkout'
  | 'main_checkout'
  | 'outside_managed_root'
  | 'missing_worktree'
  | 'path_identity_mismatch'
  | 'repository_mismatch'
  | 'branch_mismatch'
  | 'ownership_mismatch'
  | 'locked_worktree'
  | 'shared_checkout'
  | 'live_terminal'
  | 'staged_changes'
  | 'unstaged_changes'
  | 'untracked_content'
  | 'ignored_content'
  | 'conflicted_worktree'
  | 'dirty_submodule'
  | 'unpushed_commits'
  | 'git_error';

export interface WorktreeRemovalBlocker {
  readonly code: WorktreeRemovalBlockerCode;
  readonly message: string;
  readonly override?: WorktreeRemovalOverride;
}

export interface WorktreeRemovalEvidence {
  readonly recordedPath: string;
  readonly managedRoot: string;
  readonly resolvedManagedRoot: string;
  readonly resolvedPath?: string;
  readonly expectedRepositoryRoot: string;
  readonly expectedCommonDir: string;
  readonly expectedGitDir: string;
  readonly expectedBranch: string;
  readonly ownershipMarkerMatches: boolean;
  readonly ownerActive: boolean;
  readonly currentWorkingDirectory?: string;
  readonly otherSessions: readonly { readonly id: string; readonly cwd: string }[];
  readonly liveTerminals: number;
  readonly checkout?: GitCheckoutSnapshot;
  readonly status?: WorktreeStatusSummary;
  readonly pushState?: WorktreePushState;
  readonly gitErrors: readonly string[];
}

export interface WorktreeRemovalDecision {
  readonly removable: boolean;
  readonly path: string;
  readonly branch: string;
  readonly head?: string;
  readonly upstream?: string;
  readonly blockers: readonly WorktreeRemovalBlocker[];
}

export interface CheckManagedWorktreeRemovalInput {
  readonly managed: ManagedWorktree;
  readonly managedRoot: string;
  readonly ownerActive: boolean;
  readonly currentWorkingDirectory?: string;
  readonly otherSessions?: readonly { readonly id: string; readonly cwd: string }[];
  readonly liveTerminals?: number;
}

export interface RemovedManagedWorktree {
  readonly path: string;
  readonly branch: string;
  readonly branchRetained: true;
  readonly removedAt: string;
}

export type BranchDeletionConfirmation =
  | 'delete_preexisting_branch'
  | 'delete_unpushed_branch'
  | 'delete_unmerged_branch';

export type BranchDeletionBlockerCode =
  | 'protected_branch'
  | 'branch_checked_out'
  | 'active_checkout'
  | 'live_terminal'
  | 'preexisting_branch'
  | 'unpushed_commits'
  | 'unmerged_branch';

export interface BranchDeletionEvidence {
  readonly protectedBranch: boolean;
  readonly checkedOut: boolean;
  readonly activeCheckout: boolean;
  readonly liveTerminals: number;
  readonly branchPreexisted: boolean;
  readonly commitsPushed: boolean;
  readonly integrated: boolean;
}

export interface BranchDeletionBlocker {
  readonly code: BranchDeletionBlockerCode;
  readonly message: string;
  readonly confirmation?: BranchDeletionConfirmation;
}

export interface BranchDeletionDecision {
  readonly deletable: boolean;
  readonly blockers: readonly BranchDeletionBlocker[];
}
