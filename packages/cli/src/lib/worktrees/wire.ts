/**
 * The worktree wire shapes.
 *
 * These belong in `@ferretry/protocol` beside every other daemon contract, and should move there
 * when a unit owns that package: the CLI declaring its own schemas is a duplicate of the daemon's
 * domain types, and duplicates drift. They are parsed, not cast, so drift fails loudly here rather
 * than corrupting a rendering.
 */
import { z } from 'zod';

const NonEmpty = z.string().min(1);
const Instant = z.iso.datetime();

/** One worktree the daemon created and still owns. */
const ManagedWorktreeViewSchema = z.object({
  path: NonEmpty,
  branch: NonEmpty,
  repositoryRoot: NonEmpty,
  createdAt: Instant,
  initialHead: NonEmpty,
  branchPreexisted: z.boolean(),
  removedAt: Instant.optional(),
  /** The session that created it, absent once that session has ended. */
  ownerSessionId: NonEmpty.optional(),
  ownerActive: z.boolean(),
  /** Sessions other than the owner currently working in it. */
  sharedWith: z.array(NonEmpty).default([]),
});
export type ManagedWorktreeView = z.infer<typeof ManagedWorktreeViewSchema>;

export const WorktreeListResponseSchema = z.object({
  worktrees: z.array(ManagedWorktreeViewSchema),
  /** Where managed worktrees live; absent when the daemon has no managed root configured. */
  managedRoot: NonEmpty.optional(),
});
export type WorktreeListResponse = z.infer<typeof WorktreeListResponseSchema>;

const WorktreeRemovalOverrideSchema = z.enum([
  'discard_worktree_changes',
  'accept_unpushed_commits',
  'delete_unmerged_branch',
]);
export type WorktreeRemovalOverride = z.infer<typeof WorktreeRemovalOverrideSchema>;

const WorktreeRemovalBlockerSchema = z.object({
  code: NonEmpty,
  message: NonEmpty,
  /** The override that clears this blocker; absent means nothing clears it. */
  override: WorktreeRemovalOverrideSchema.optional(),
});
export type WorktreeRemovalBlocker = z.infer<typeof WorktreeRemovalBlockerSchema>;

export const WorktreeRemovalDecisionSchema = z.object({
  removable: z.boolean(),
  path: NonEmpty,
  branch: NonEmpty,
  head: NonEmpty.optional(),
  upstream: NonEmpty.optional(),
  blockers: z.array(WorktreeRemovalBlockerSchema),
});
export type WorktreeRemovalDecision = z.infer<typeof WorktreeRemovalDecisionSchema>;

const BranchDeletionConfirmationSchema = z.enum([
  'delete_preexisting_branch',
  'delete_unpushed_branch',
  'delete_unmerged_branch',
]);
export type BranchDeletionConfirmation = z.infer<typeof BranchDeletionConfirmationSchema>;

export const RemovedWorktreeSchema = z.object({
  path: NonEmpty,
  branch: NonEmpty,
  branchRetained: z.boolean(),
  removedAt: Instant,
});
export type RemovedWorktree = z.infer<typeof RemovedWorktreeSchema>;

export const WorktreeRemovalRequestSchema = z.strictObject({
  path: NonEmpty,
  overrides: z.array(WorktreeRemovalOverrideSchema),
  deleteBranch: z.boolean(),
  confirmations: z.array(BranchDeletionConfirmationSchema),
});
export type WorktreeRemovalRequest = z.infer<typeof WorktreeRemovalRequestSchema>;
