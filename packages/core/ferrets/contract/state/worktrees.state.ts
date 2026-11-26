import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';

// ─── worktrees.json (today's managed worktree registry, `lib/worktrees/registry.ts`) ────────────────────────────

const AdoptionIdentitySchema = z.strictObject({
  checkout: z.string().regex(/^\d+:\d+$/),
  gitDirectory: z.string().regex(/^\d+:\d+$/),
  commonDirectory: z.string().regex(/^\d+:\d+$/),
});

export const ManagedWorktreeRecordSchema = z.strictObject({
  version: z.literal(1),
  origin: z.enum(['managed', 'adopted']).optional(),
  adoptionIdentity: AdoptionIdentitySchema.optional(),
  removalIdentity: AdoptionIdentitySchema.optional(),
  path: z.string().min(1),
  branch: z.string().min(1),
  repositoryRoot: z.string().min(1),
  commonDir: z.string().min(1),
  gitDir: z.string().min(1),
  ownershipToken: z.string().min(1),
  createdAt: z.string().min(1),
  initialHead: z.string().min(1),
  branchPreexisted: z.boolean(),
  sourceCwd: z.string().min(1),
  relativeCwd: z.string(),
  ownerSessionId: z.string().min(1).optional(),
  removalStartedAt: z.string().min(1).optional(),
  removedAt: z.string().min(1).optional(),
});

export const ManagedWorktreeIntentSchema = z.strictObject({
  version: z.literal(1),
  origin: z.enum(['managed', 'adopted']).optional(),
  gitDir: z.string().min(1).optional(),
  adoptionIdentity: AdoptionIdentitySchema.optional(),
  path: z.string().min(1),
  branch: z.string().min(1),
  repositoryRoot: z.string().min(1),
  commonDir: z.string().min(1),
  ownershipToken: z.string().min(1),
  declaredAt: z.string().min(1),
  initialHead: z.string().min(1),
  branchPreexisted: z.boolean(),
  sourceCwd: z.string().min(1),
  relativeCwd: z.string(),
  ownerSessionId: z.string().min(1).optional(),
});

/**
 * `state/ferrets/worktrees.json` (§9.2, the contract's `WorktreesFile`). Its `format: 1` is stamped and checked by the
 * kernel's state port, so the document here is the body only.
 */
export const ManagedWorktreeDocumentSchema = z.strictObject({
  worktrees: z.array(ManagedWorktreeRecordSchema),
  intents: z.array(ManagedWorktreeIntentSchema),
});
export type ManagedWorktreeDocument = z.infer<typeof ManagedWorktreeDocumentSchema>;
export const WorktreesFile = defineState({
  name: 'worktrees',
  path: 'worktrees.json',
  store: 'json',
  format: 1,
  schema: ManagedWorktreeDocumentSchema,
});
