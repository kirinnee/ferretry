import type { RemovedWorktree, WorktreeRemovalDecision, WorktreeRemovalRequest } from '../worktrees.ts';

/** Worktree lifecycle through the same service as the HTTP routes; grants belong to the caller. */
export interface WorktreesApi {
  /** Read-only: never settles registry intents or changes a checkout. Missing evidence refuses removal. */
  checkWorktreeRemoval?(path: string, currentWorkingDirectory?: string): Promise<WorktreeRemovalDecision>;
  /** Re-proves identity and occupancy through the existing managed/adopted removal path. */
  removeWorktree?(request: WorktreeRemovalRequest): Promise<RemovedWorktree>;
}
