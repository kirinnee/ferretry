import type { BranchDeletionBlocker, WorktreeRemovalBlocker } from '@ferretry/protocol';

/**
 * Why a managed-worktree operation was refused.
 *
 * THE TAXONOMY IS A DOMAIN FACT, not an adapter detail, which is why it lives here rather than
 * beside the Git gateway that raises most of it. The mount turns each code into a status and a
 * client-readable code, and a mount in `src/lib` may not import an adapter — so a refusal declared
 * next to the child that produced it would have had to be re-derived from prose at the boundary,
 * which is how a 409 becomes a 500.
 */
export type WorktreeErrorCode =
  | 'not_git_repository'
  | 'invalid_session_id'
  | 'invalid_ownership_token'
  | 'invalid_branch'
  | 'branch_in_use'
  | 'ambiguous_remote_branch'
  | 'destination_exists'
  | 'unsafe_checkout_filter'
  | 'verification_failed'
  | 'unsafe_remove'
  | 'unknown_worktree'
  | 'no_managed_root'
  | 'unresolved_base'
  | 'registry_damaged';

export class WorktreeError extends Error {
  constructor(
    readonly code: WorktreeErrorCode,
    message: string,
    readonly blockers: readonly WorktreeRemovalBlocker[] = [],
    readonly branchBlockers: readonly BranchDeletionBlocker[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorktreeError';
  }
}

/**
 * A removal refusal proved before `git worktree remove` was spawned.
 *
 * This subtype is recovery evidence. The service may clear its removal stamp immediately because
 * the adapter is asserting that no destructive mutation began. Every other thrown error is
 * ambiguous until the checkout is re-observed, including timeouts and ordinary Git failures.
 */
export class WorktreeRemovalRefusal extends WorktreeError {
  constructor(message: string, blockers: readonly WorktreeRemovalBlocker[] = [], options?: ErrorOptions) {
    super('unsafe_remove', message, blockers, [], options);
    this.name = 'WorktreeRemovalRefusal';
  }
}
