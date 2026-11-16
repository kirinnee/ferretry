import { z } from 'zod';

/**
 * The JSON answers of Ferrets' file-browser routes. The daemon's copy lives in its own half and the app's in its own, so
 * the verbs read the wire with their own schemas; objects are not strict, so a newer daemon's extra field never turns
 * a read into a failure.
 */
const Size = z.number().int().nonnegative();

const FsEntrySchema = z.object({
  name: z.string().min(1),
  type: z.enum(['file', 'dir', 'symlink']),
  size: Size.optional(),
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
  size: Size,
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
  additions: Size.optional(),
  deletions: Size.optional(),
});
export type FsChange = z.infer<typeof FsChangeSchema>;

export const FsChangesSchema = z.object({
  repo: z.boolean(),
  branch: z.string().min(1).optional(),
  changes: z.array(FsChangeSchema),
  truncated: z.boolean().optional(),
});
export type FsChanges = z.infer<typeof FsChangesSchema>;
