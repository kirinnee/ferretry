import { z } from 'zod';

const NonNegativeIntegerSchema = z.number().int().nonnegative();

const FsEntrySchema = z.object({
  name: z.string().min(1),
  type: z.enum(['file', 'dir', 'symlink']),
  size: NonNegativeIntegerSchema.optional(),
  mtime: z.string().optional(),
  ignored: z.boolean().optional(),
  denied: z.boolean().optional(),
  escapes: z.boolean().optional(),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

export const FsListingSchema = z.object({
  root: z.string().min(1),
  path: z.string(),
  entries: z.array(FsEntrySchema),
  truncated: z.boolean().optional(),
});
export type FsListing = z.infer<typeof FsListingSchema>;

export const FsFileViewSchema = z.object({
  path: z.string().min(1),
  size: NonNegativeIntegerSchema,
  mtime: z.string().optional(),
  content: z.string().optional(),
  binary: z.boolean().optional(),
  tooLarge: z.boolean().optional(),
  denied: z.boolean().optional(),
  ignored: z.boolean().optional(),
  reason: z.enum(['denylist', 'ignored', 'escapes']).optional(),
  rev: z.literal('head').optional(),
});
export type FsFileView = z.infer<typeof FsFileViewSchema>;

const FsChangeSchema = z.object({
  path: z.string().min(1),
  status: z.string().length(2),
  from: z.string().min(1).optional(),
  additions: NonNegativeIntegerSchema.optional(),
  deletions: NonNegativeIntegerSchema.optional(),
});
export type FsChange = z.infer<typeof FsChangeSchema>;

export const FsChangesSchema = z.object({
  repo: z.boolean(),
  branch: z.string().min(1).optional(),
  changes: z.array(FsChangeSchema),
  truncated: z.boolean().optional(),
});
export type FsChanges = z.infer<typeof FsChangesSchema>;
