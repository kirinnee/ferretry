import { z } from 'zod';

/**
 * The JSON answers of Ferrets' file-browser routes (`GET /v1/ferrets/:ferretId/fs`, `fs/file`, `fs/changes`).
 *
 * `fs/diff` answers plain text, so it has no schema here. These are the shapes a browser trusts when it renders a
 * listing and a file: an entry flagged `denied`, `ignored` or `escapes` is never offered as openable, so a reader that
 * took the body on faith could promote a refused path to a live one. The daemon's copy lives in its own half
 * (`daemon/lib/session/filesystem`), which an app half cannot import, so the wire is read here with its own schemas.
 *
 * Objects are not strict: a newer daemon may add a field this page has no use for, and that must not turn every
 * listing into a failed read.
 */
const FsEntryTypeSchema = z.enum(['file', 'dir', 'symlink']);

const FsEntrySchema = z.object({
  name: z.string().min(1),
  type: FsEntryTypeSchema,
  size: z.number().int().nonnegative().optional(),
  mtime: z.string().optional(),
  /** Gitignored: listed, never served. */
  ignored: z.boolean().optional(),
  /** On the unconditional denylist: listed, never served. */
  denied: z.boolean().optional(),
  /** A symlink resolving outside the ferret's root, or broken: listed, never served. */
  escapes: z.boolean().optional(),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;

export const FsListingSchema = z.object({
  /** The ferret's root as pinned. */
  root: z.string(),
  /** The listed directory relative to the root; `''` is the root itself. */
  path: z.string(),
  entries: z.array(FsEntrySchema),
  truncated: z.boolean().optional(),
});
export type FsListing = z.infer<typeof FsListingSchema>;

const FsRefusalReasonSchema = z.enum(['denylist', 'ignored', 'escapes']);

export const FsFileSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.string().optional(),
  /** Present only when content is actually served. Secret values in it were masked by the daemon. */
  content: z.string().optional(),
  /** Present only when the caller asked for the bounded byte representation. */
  base64: z.string().optional(),
  binary: z.boolean().optional(),
  tooLarge: z.boolean().optional(),
  denied: z.boolean().optional(),
  ignored: z.boolean().optional(),
  reason: FsRefusalReasonSchema.optional(),
  /** Which rule refused it — the ignore file, line and pattern, a Git failure, or the denied name. */
  rule: z.string().optional(),
  rev: z.literal('head').optional(),
  /** A private value was masked in what was served: this is not the file, so it is never offered as a download. */
  redacted: z.boolean().optional(),
});
export type FsFile = z.infer<typeof FsFileSchema>;

const FsChangeSchema = z.object({
  /** Relative to the ferret's folder, never to the repository root. */
  path: z.string().min(1),
  /** The two-character porcelain XY code, for example `" M"`, `"A "`, `"??"`. */
  status: z.string(),
  from: z.string().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});
export type FsChange = z.infer<typeof FsChangeSchema>;

export const FsChangesSchema = z.object({
  repo: z.boolean(),
  branch: z.string().optional(),
  changes: z.array(FsChangeSchema),
  /** Git's own output hit the byte cap, so the list may be incomplete. */
  truncated: z.boolean().optional(),
});
export type FsChanges = z.infer<typeof FsChangesSchema>;
