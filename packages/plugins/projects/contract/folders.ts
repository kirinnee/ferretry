import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';

/**
 * The folder explorer's wire (`GET|POST /v1/projects/folders`): what the "pick a folder" screen needs, and nothing a
 * file's content or a private folder's names could ride on. Paths are absolute, or `~`-relative as the caller named them.
 */

/** The most entries one listing answers; past it `truncated` is true. */
export const MAX_FOLDER_ENTRIES = 500;

/** The longest path a request may name (Linux `PATH_MAX`). */
export const MAX_FOLDER_PATH_LENGTH = 4096;

export const FolderEntrySchema = z.strictObject({
  name: z.string().min(1),
  kind: z.enum(['folder', 'file']),
  /** A folder that holds a `.git` (a folder, or the file a work tree keeps). Always false for a file. */
  isRepo: z.boolean(),
  /** A name starting with `.`; present in a listing only when `hidden=1` was asked. */
  hidden: z.boolean(),
  modifiedAt: InstantSchema,
});
export type FolderEntry = z.infer<typeof FolderEntrySchema>;

export const FolderCrumbSchema = z.strictObject({ name: z.string().min(1), path: z.string().min(1) });
export type FolderCrumb = z.infer<typeof FolderCrumbSchema>;

export const FolderListingSchema = z.strictObject({
  /** The folder listed, absolute and fully resolved (no link on the way). */
  path: z.string().min(1),
  /** From the home folder (`~`), or from `/` for a folder outside it, down to `path`. */
  crumbs: z.array(FolderCrumbSchema),
  /** Folders first, then files, each by name. */
  entries: z.array(FolderEntrySchema).max(MAX_FOLDER_ENTRIES),
  truncated: z.boolean(),
  /** Present (true) when `path` is a place so wide that a project there is "your whole disk or home": `/`, `/home`, `/Users`, the home. */
  broad: z.literal(true).optional(),
});
export type FolderListing = z.infer<typeof FolderListingSchema>;

/** One folder name: a single level, never a path, never hidden. The checks the daemon also makes. */
export const NewFolderNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(name => name === name.trim(), { message: 'a folder name has no leading or trailing space' })
  .refine(name => !name.startsWith('.'), { message: 'a folder name may not start with a dot' })
  .refine(name => !/[/\\\0\p{Cc}]/u.test(name), {
    message: 'a folder name is one level: no slash or control character',
  });

export const MakeFolderRequestSchema = z.strictObject({
  parent: z.string().min(1).max(MAX_FOLDER_PATH_LENGTH),
  name: NewFolderNameSchema,
});
export type MakeFolderRequest = z.infer<typeof MakeFolderRequestSchema>;

export const MakeFolderResultSchema = z.strictObject({ path: z.string().min(1) });
export type MakeFolderResult = z.infer<typeof MakeFolderResultSchema>;
