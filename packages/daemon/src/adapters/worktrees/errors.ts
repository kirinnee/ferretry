import type { WorktreeRemovalBlocker } from '../../lib/worktrees/types.ts';

export type WorktreeAdapterErrorCode =
  | 'not_git_repository'
  | 'invalid_branch'
  | 'branch_in_use'
  | 'ambiguous_remote_branch'
  | 'destination_exists'
  | 'unsafe_checkout_filter'
  | 'verification_failed'
  | 'unsafe_remove';

export class WorktreeAdapterError extends Error {
  constructor(
    readonly code: WorktreeAdapterErrorCode,
    message: string,
    readonly blockers: readonly WorktreeRemovalBlocker[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorktreeAdapterError';
  }
}
