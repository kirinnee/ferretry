import { z } from 'zod';
import {
  RemovedWorktreeSchema,
  RepoWorktreeListResponseSchema,
  ReviewedWorktreeIdentitySchema,
} from '@ferretry/core-ferrets/contract';
import { BranchPullResultSchema } from '@ferretry/plugin-pulls/contract';
import { ProjectIdSchema } from '@ferretry/plugin-projects/contract';

export const TidyWorktreeVerdictSchema = z.strictObject({
  removable: z.boolean(),
  reason: z.string().min(1),
  reviewedIdentity: ReviewedWorktreeIdentitySchema.optional(),
});
export type TidyWorktreeVerdict = z.infer<typeof TidyWorktreeVerdictSchema>;

export const TidyWorktreeRowSchema = z.strictObject({
  commonDirectory: z.string().min(1),
  repository: z.string().min(1),
  worktree: RepoWorktreeListResponseSchema.shape.worktrees.element,
  pull: BranchPullResultSchema.optional(),
  verdict: TidyWorktreeVerdictSchema,
});
export type TidyWorktreeRow = z.infer<typeof TidyWorktreeRowSchema>;

export const TidyWorktreesSchema = z.strictObject({
  project: ProjectIdSchema,
  rows: z.array(TidyWorktreeRowSchema).max(500),
  unavailable: z.array(z.strictObject({ commonDirectory: z.string(), reason: z.string() })),
  truncated: z.boolean(),
});
export type TidyWorktrees = z.infer<typeof TidyWorktreesSchema>;

const AbsolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(path => path.startsWith('/') && !/\p{Cc}/u.test(path));

/** Both apply routes take the exact rows the person reviewed. Never expand a batch or renew consent by path. */
export const TidyWorktreeRemoveRequestSchema = z.strictObject({
  worktrees: z
    .array(z.strictObject({ path: AbsolutePath, identity: ReviewedWorktreeIdentitySchema }))
    .min(1)
    .max(500),
  currentWorkingDirectory: AbsolutePath.optional(),
});
export type TidyWorktreeRemoveRequest = z.infer<typeof TidyWorktreeRemoveRequestSchema>;

export const TidyWorktreeRemoveResultSchema = z.strictObject({
  removed: z.array(RemovedWorktreeSchema),
  skipped: z.array(z.strictObject({ path: AbsolutePath, reason: z.string().min(1) })),
});
export type TidyWorktreeRemoveResult = z.infer<typeof TidyWorktreeRemoveResultSchema>;
