/**
 * The files route's wire shapes (r9 E5). Added beside E1's
 * `wire.ts` rather than inside it: `PullFile` is E1's and is not changed.
 */
import { z } from 'zod';
import { MAX_PULL_FILES, PullFileSchema } from './wire.ts';

/** The most patch text one answer carries; a file past it is listed with no `patch` ("open on GitHub"). */
export const MAX_FILES_PATCH_BYTES = 8 * 1024 * 1024;

export const PullFilesAnswerSchema = z.strictObject({
  files: z.array(PullFileSchema).max(MAX_PULL_FILES),
  /** More files exist than are listed: GitHub's 3000 cap, or the paging bound, was reached. */
  truncated: z.boolean(),
  /** Files GitHub listed that were not understood and are left out. */
  unreadable: z.number().int().nonnegative(),
  /** Every page came from the cache (`304`): nothing changed since the last read. */
  fromCache: z.boolean(),
});
export type PullFilesAnswer = z.infer<typeof PullFilesAnswerSchema>;
