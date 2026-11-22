import {
  SessionFileIndexCoverageSchema,
  SessionFileIndexEntrySchema,
  SessionFileIndexSkipSchema,
} from '@ferretry/core-ferrets/contract';
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';

/**
 * A project's file finder (&F6061 U5): every file name inside a registered project folder that Git does not ignore, found
 * once on the daemon and searched there, so a phone over a relay is sent the top of the matches and never the list.
 *
 * It is NAMES only. No route here returns file content, and every path it names is re-gated by the read that follows
 * (the ferret file routes). `coverage` and `skipped` are the ferret index's own shapes: a bound that bit says so, and a
 * partial index can never announce an empty result as the truth.
 */

/** The most matches one answer carries, and what it carries when the caller says nothing. */
export const MAX_PROJECT_FILE_MATCHES = 200;
export const DEFAULT_PROJECT_FILE_MATCHES = 50;

/** How many of the biggest top-level folders an index names, so the app can say WHERE a cap bit. */
export const PROJECT_BIGGEST_FOLDERS = 5;

/** The most nested worktrees an index names; the count past it is still in `skipped`. */
export const MAX_PROJECT_WORKTREES_NAMED = 50;

/** One top-level folder and how many indexed files sit under it. */
export const ProjectFolderCountSchema = z.strictObject({
  folder: z.string().min(1).max(512),
  files: z.number().int().min(1),
});
export type ProjectFolderCount = z.infer<typeof ProjectFolderCountSchema>;

/**
 * What one build of the index knew, without the names themselves.
 *
 * `indexed` is how many files are held (never more than the project cap), `coverage: 'partial'` means a bound or an
 * unreadable folder cut the build short, and `nestedWorktrees` are the linked worktrees and submodule checkouts the build
 * deliberately did not enter (owner decision D4), by folder.
 */
export const ProjectIndexSummarySchema = z
  .strictObject({
    builtAt: InstantSchema,
    indexed: z.number().int().min(0),
    coverage: SessionFileIndexCoverageSchema,
    skipped: z.array(SessionFileIndexSkipSchema).max(5),
    biggestFolders: z.array(ProjectFolderCountSchema).max(PROJECT_BIGGEST_FOLDERS),
    nestedWorktrees: z.array(z.string().min(1).max(1024)).max(MAX_PROJECT_WORKTREES_NAMED),
  })
  .superRefine((summary, ctx) => {
    const incomplete = summary.skipped.some(skip => skip.reason === 'unreadable' || skip.reason === 'truncated');
    if ((summary.coverage === 'complete') === incomplete)
      ctx.addIssue({
        code: 'custom',
        path: ['coverage'],
        message: 'coverage is partial exactly when a subtree was unreadable or a bound bit',
      });
  });
export type ProjectIndexSummary = z.infer<typeof ProjectIndexSummarySchema>;

/** `GET /v1/projects/:id/files`: the best matches, and what the index could and could not see. */
export const ProjectFilesAnswerSchema = z.strictObject({
  files: z.array(SessionFileIndexEntrySchema).max(MAX_PROJECT_FILE_MATCHES),
  /** How many files matched before the answer was cut to `limit`. */
  total: z.number().int().min(0),
  /** An older index was answered and a newer one is being built. */
  rebuilding: z.boolean(),
  index: ProjectIndexSummarySchema,
});
export type ProjectFilesAnswer = z.infer<typeof ProjectFilesAnswerSchema>;

/**
 * `GET /v1/projects/:id/files/status` and `POST /v1/projects/:id/files/rescan`: the summary alone, for a badge. `index` is
 * absent while the first build has not finished.
 */
export const ProjectFilesStatusSchema = z.strictObject({
  rebuilding: z.boolean(),
  index: ProjectIndexSummarySchema.optional(),
});
export type ProjectFilesStatus = z.infer<typeof ProjectFilesStatusSchema>;
