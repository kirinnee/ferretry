import type {
  BranchDeletionBlocker,
  BranchDeletionBlockerCode,
  BranchDeletionConfirmation,
  BranchDeletionDecision,
  WorktreeLiveState,
  WorktreeRemovalBlocker,
  WorktreeRemovalBlockerCode,
  WorktreeBase,
  WorktreeRemovalDecision,
  WorktreeRemovalOverride,
  WorktreeStatusSummaryView,
} from '@ferretry/protocol';

/**
 * THE DECISION VOCABULARY IS NOT DECLARED HERE, and that is deliberate.
 *
 * Blocker codes, override names, confirmation names and the two decisions they produce are facts the
 * daemon and its clients must agree on exactly, so `@ferretry/protocol` owns them and this domain
 * re-exports the names it uses. Re-declaring them here would be a second enumeration nothing derives
 * from the first — and the drift it invites is not hypothetical: the client's copy typed a blocker
 * code as "any non-empty string" for this surface's whole first life, so a daemon renaming one would
 * have been rendered rather than refused.
 */
export type {
  BranchDeletionBlocker,
  BranchDeletionBlockerCode,
  BranchDeletionConfirmation,
  BranchDeletionDecision,
  WorktreeLiveState,
  WorktreeRemovalBlocker,
  WorktreeRemovalBlockerCode,
  WorktreeRemovalDecision,
  WorktreeRemovalOverride,
  WorktreeBase,
};

/** The daemon-side name for the status summary the wire carries. */
export type WorktreeStatusSummary = WorktreeStatusSummaryView;

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

/**
 * One managed checkout, as the daemon durably records it.
 *
 * EVERY FIELD HERE IS SOMETHING GIT CANNOT RECONSTRUCT. Git knows a directory is a linked worktree
 * on a branch; it does not know who asked for it, when Ferretry made it, which commit it started
 * from, whether the branch already existed before the fork, or where inside the source tree the
 * caller was standing. Losing any of those turns a safety question into a guess: without
 * `branchPreexisted` a removal cannot tell "delete the branch I made for you" from "delete the
 * branch you already had", and it would have to refuse both or destroy both.
 */
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
  /** The checkout the fork was taken from, canonicalized. */
  readonly sourceCwd: string;
  /** Where inside that checkout the caller stood; the empty string is its root. */
  readonly relativeCwd: string;
  /** The session that asked for it. Absent means nothing but the daemon owns it. */
  readonly ownerSessionId?: string;
  /**
   * When a removal was AUTHORIZED and Git was about to be asked, written before the destruction.
   *
   * Present with no `removedAt` means the answer is unknown: either the mutation was refused, or the
   * daemon died between the two writes. Reconciliation looks at the disk and settles it. Without
   * this stamp a crash left a row pointing at a directory that was already gone, and every retry
   * failed on `missing_worktree` instead of healing.
   */
  readonly removalStartedAt?: string;
  readonly removedAt?: string;
}

/**
 * A checkout this daemon is ABOUT to create, filed before Git is asked to create it.
 *
 * Everything here is known at plan time — the destination, the branch, the commit it will start
 * from, whether the branch pre-existed, where the caller was standing. The one field an intent
 * cannot carry is `gitDir`, because Git has not made it yet, and that absence is exactly what
 * distinguishes a declared checkout from a finished one.
 */
export interface ManagedWorktreeIntent {
  readonly version: 1;
  readonly path: string;
  readonly branch: string;
  readonly repositoryRoot: string;
  readonly commonDir: string;
  readonly ownershipToken: string;
  readonly declaredAt: string;
  readonly initialHead: string;
  readonly branchPreexisted: boolean;
  readonly sourceCwd: string;
  readonly relativeCwd: string;
  readonly ownerSessionId?: string;
}

/**
 * What became of a declared creation, decided by looking at the disk.
 *
 * THREE ANSWERS, and the third is the one that matters. `absent` means Git never got as far as
 * making anything, so the intent is dropped. `adopted` means the checkout is there and proves it is
 * ours, so it becomes an ordinary record. `unverified` means something IS at that path and cannot be
 * shown to be ours — which is the case a reconciliation must never quietly discard, because
 * discarding the row is what makes a directory invisible.
 */
export type ManagedWorktreeAdoption =
  | { readonly kind: 'adopted'; readonly managed: ManagedWorktree }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unverified'; readonly reason: string };

/**
 * What currently occupies the path of a recorded checkout.
 *
 * `owned` is deliberately stronger than "the path exists": it names the same linked-worktree and
 * ownership-token incarnation the registry recorded. A foreign directory, symlink, or later
 * checkout at the same path is `unverified`, so reconciliation keeps its recovery stamp rather than
 * treating somebody else's object as proof that the interrupted removal never happened.
 */
export type ManagedWorktreePresence =
  | { readonly kind: 'owned' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unverified'; readonly reason: string };

export interface ManagedWorktreePlan {
  readonly sourceCwd: string;
  readonly path: string;
  readonly sessionCwd: string;
  readonly relativeCwd: string;
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

/** Where a new checkout starts from. The protocol owns the vocabulary; this is the daemon's name for it. */
export type ManagedWorktreeBase = WorktreeBase;

export interface CreateManagedWorktreeInput {
  readonly sourceCwd: string;
  readonly branch: string;
  /** The path-safe id the destination directory is keyed by; a session id when a session owns it. */
  readonly sessionId: string;
  /** The owning session, absent when the checkout is owned by nothing but the daemon. */
  readonly ownerSessionId?: string;
  readonly ownershipToken: string;
  readonly managedRoot: string;
  readonly base?: ManagedWorktreeBase;
  readonly timeoutMs?: number;
  readonly onPlanned?: (plan: ManagedWorktreePlan) => Promise<void>;
}

export type WorktreePushState =
  | { readonly kind: 'pushed'; readonly upstream?: string }
  | { readonly kind: 'unpushed'; readonly upstream?: string; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string };

/** How far a branch has diverged from its upstream, when both counts could be read. */
export interface WorktreeDivergence {
  readonly ahead: number;
  readonly behind: number;
}

export interface BranchDeletionEvidence {
  readonly protectedBranch: boolean;
  readonly checkedOut: boolean;
  readonly activeCheckout: boolean;
  readonly liveTerminals: number;
  readonly branchPreexisted: boolean;
  readonly commitsPushed: boolean;
  readonly integrated: boolean;
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
  /**
   * Host evidence that could not be established, in words a person can act on.
   *
   * A COUNT OF ZERO AND "I COULD NOT LOOK" ARE DIFFERENT FACTS, and collapsing them is what turns an
   * un-forceable refusal into decoration: a daemon whose tmux server is unreachable would report
   * every checkout as free of live shells. Each entry becomes an `undetermined_evidence` blocker.
   */
  readonly undeterminedEvidence?: readonly string[];
  readonly checkout?: GitCheckoutSnapshot;
  readonly status?: WorktreeStatusSummary;
  readonly pushState?: WorktreePushState;
  /** Branch-deletion evidence, absent when the checkout could not be inspected far enough to say. */
  readonly branchEvidence?: BranchDeletionEvidence;
  /** The confirmations this caller gave, so the check can price the branch deletion they asked for. */
  readonly branchConfirmations?: readonly BranchDeletionConfirmation[];
  readonly gitErrors: readonly string[];
}

export interface CheckManagedWorktreeRemovalInput {
  readonly managed: ManagedWorktree;
  readonly managedRoot: string;
  readonly ownerActive: boolean;
  readonly currentWorkingDirectory?: string;
  readonly otherSessions?: readonly { readonly id: string; readonly cwd: string }[];
  readonly liveTerminals?: number;
  /** Host evidence the caller could not establish. Each entry becomes an un-forceable refusal. */
  readonly undeterminedEvidence?: readonly string[];
  readonly confirmations?: readonly BranchDeletionConfirmation[];
}

/** What one refresh learned about a checkout: what Git says now, and what that means for removal. */
export interface ManagedWorktreeInspection {
  readonly live: WorktreeLiveState;
  readonly decision: WorktreeRemovalDecision;
  /**
   * The branch-deletion evidence this refresh gathered, absent when the checkout could not be read
   * far enough to gather any. It travels beside the decision so a removal that then deletes the
   * branch judges the SAME evidence its caller was shown, rather than re-reading a repository that
   * has since lost the checkout the evidence came from.
   */
  readonly branchEvidence?: BranchDeletionEvidence;
}

export interface RemoveManagedWorktreeInput extends CheckManagedWorktreeRemovalInput {
  readonly overrides: readonly WorktreeRemovalOverride[];
  readonly deleteBranch: boolean;
  /** Re-read host occupancy inside the repository queue immediately before the final preflight. */
  readonly refreshEvidence?: () => Promise<CheckManagedWorktreeRemovalInput>;
}

export interface RemovedManagedWorktree {
  readonly path: string;
  readonly branch: string;
  readonly branchRetained: boolean;
  readonly branchBlockers: readonly BranchDeletionBlocker[];
  readonly removedAt: string;
}
