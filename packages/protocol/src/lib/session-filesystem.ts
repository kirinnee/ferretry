import { z } from 'zod';

/**
 * The JSON answers of the session filesystem routes (`/v1/sessions/:id/fs`, `fs/file`, `fs/changes`).
 *
 * `fs/index` has its own schema in `session-search.ts` and `fs/diff` answers plain text, so neither is
 * here. These are the shapes a browser trusts when it proves an `@file` reference and when it renders a
 * file: a listing entry flagged `denied`, `ignored` or `escapes` is never offered as a link, so a reader
 * that took the body on faith could promote a refused path to a live one.
 *
 * Objects are not strict: a newer daemon may add a field an older browser has no use for, and that must
 * not turn every listing into a failed read.
 */
export const SessionFsEntryTypeSchema = z.enum(['file', 'dir', 'symlink']);
export type SessionFsEntryType = z.infer<typeof SessionFsEntryTypeSchema>;

export const SessionFsEntrySchema = z.object({
  name: z.string().min(1),
  type: SessionFsEntryTypeSchema,
  size: z.number().int().nonnegative().optional(),
  mtime: z.string().optional(),
  /** Gitignored: listed, never served. */
  ignored: z.boolean().optional(),
  /** On the unconditional denylist: listed, never served. */
  denied: z.boolean().optional(),
  /** A symlink resolving outside the session root, or broken: listed, never served. */
  escapes: z.boolean().optional(),
});
export type SessionFsEntry = z.infer<typeof SessionFsEntrySchema>;

export const SessionFsListingSchema = z.object({
  /** The session root as pinned. */
  root: z.string(),
  /** The listed directory relative to the root; `''` is the root itself. */
  path: z.string(),
  entries: z.array(SessionFsEntrySchema),
  truncated: z.boolean().optional(),
});
export type SessionFsListing = z.infer<typeof SessionFsListingSchema>;

export const SessionFsRefusalReasonSchema = z.enum(['denylist', 'ignored', 'escapes']);
export type SessionFsRefusalReason = z.infer<typeof SessionFsRefusalReasonSchema>;

export const SessionFsFileSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.string().optional(),
  /** Present only when content is actually served. */
  content: z.string().optional(),
  /** Present only when the caller asked for the bounded byte representation. */
  base64: z.string().optional(),
  binary: z.boolean().optional(),
  tooLarge: z.boolean().optional(),
  denied: z.boolean().optional(),
  ignored: z.boolean().optional(),
  reason: SessionFsRefusalReasonSchema.optional(),
  rev: z.literal('head').optional(),
});
export type SessionFsFile = z.infer<typeof SessionFsFileSchema>;

export const SessionGitChangeSchema = z.object({
  /** Relative to the session cwd, never to the repository root. */
  path: z.string().min(1),
  /** The two-character porcelain XY code, for example `" M"`, `"A "`, `"??"`. */
  status: z.string(),
  from: z.string().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});
export type SessionGitChange = z.infer<typeof SessionGitChangeSchema>;

export const SessionFsChangesSchema = z.object({
  repo: z.boolean(),
  branch: z.string().optional(),
  changes: z.array(SessionGitChangeSchema),
  /** Git's own output hit the byte cap, so the list may be incomplete. */
  truncated: z.boolean().optional(),
});
export type SessionFsChanges = z.infer<typeof SessionFsChangesSchema>;
