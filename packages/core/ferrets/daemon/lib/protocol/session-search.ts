import { z } from 'zod';
import { NonNegativeIntegerSchema } from './common.ts';

/**
 * One session's file and task search: what a query MEANS, and what a file index is allowed to claim.
 *
 * WHY THE DECISION LIVES HERE AND NOT IN A CLIENT. "Does this task match what the reader typed" was
 * answered in the browser, which forced the browser to hold every task's description, original ask and
 * clarifications — prose the list route deliberately drops — so it read the board and then re-read every
 * row one by one. The predicate is a decision, not a constant, and it sits above both consumers in the
 * package they already share; the daemon can then answer a narrowed board in the read it was already
 * doing, and one unreadable row stops being able to erase the whole result set.
 *
 * WHY COVERAGE AND SKIPS ARE PART OF THE INDEX AND NOT AN AFTERTHOUGHT. A file index is assembled from a
 * tree whose subtrees can be refused by policy, unreadable by permission, or simply larger than any
 * bounded walk. A response that reported only the files it managed to collect would be indistinguishable
 * from a complete one, and a reader would conclude a file does not exist when it was merely not looked
 * at. So every omission is counted and named, and {@link SessionFileIndexResponseSchema} REFUSES a
 * document that hid an incomplete walk behind `coverage: 'complete'`.
 *
 * `denied`, `excluded` and `unsupported` deliberately do NOT make a walk partial. They are respectively
 * secret-like paths the daemon never serves, noisy metadata/dependency/build/cache roots search never
 * enters, and entries that are not current regular files. An index without them is still the whole
 * searchable set — they are counted so a reader is never left to infer what silence meant.
 *
 * DECLARED GAP: gitignored paths are neither listed nor counted. The rule belongs to Git and is applied
 * by it, and counting what it excluded would mean enumerating the ignored tree — which is the exact leak
 * the ignore gate exists to prevent, since the names inside an ignored directory are themselves the
 * secret. A reader is therefore told nothing about how much gitignore removed, and that is deliberate.
 */

/**
 * Longest query accepted at a boundary.
 *
 * A search term is something a person typed, and a substring scan over every task's prose is linear in
 * this number times the board. Refusing beyond it is cheaper than truncating, because a truncated query
 * answers a question nobody asked and looks like a working search returning wrong rows.
 */
export const MAX_SESSION_SEARCH_QUERY_LENGTH = 200;

/** Longest root-relative path the search wire will carry. POSIX itself stops at this scale. */
export const MAX_SESSION_FILE_INDEX_PATH_LENGTH = 4_096;

/** Longest basename the search wire will carry. */
export const MAX_SESSION_FILE_INDEX_NAME_LENGTH = 255;

/** Largest complete candidate set one response may carry. The daemon uses this same owned fact. */
export const MAX_SESSION_FILE_INDEX_FILES = 20_000;

const DELETE_CODE_POINT = 0x7f;
const LAST_C0_CODE_POINT = 0x1f;

/** Control characters are neither useful search text nor safe terminal-visible path content. */
function hasControlCharacter(raw: string): boolean {
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= LAST_C0_CODE_POINT || code === DELETE_CODE_POINT) return true;
  }
  return false;
}

export const SessionSearchQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SESSION_SEARCH_QUERY_LENGTH)
  .refine(query => !hasControlCharacter(query), 'search text may not contain control characters');
export type SessionSearchQuery = z.infer<typeof SessionSearchQuerySchema>;

/**
 * The comparable form of a query: surrounding whitespace removed, then deterministically case folded.
 *
 * Exported because a caller that wants to rank or highlight needs the same folded text the match was
 * decided on; deriving it a second time is how the two stop agreeing.
 */
export function normalizeSessionSearchQuery(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The task fields a session search reads, structurally — number, title, description, original ask and
 * every clarification.
 *
 * Declared as the shape rather than as `Task` so a client holding a partial projection can still ask the
 * question, and so this module never has to import the task record to answer it.
 */
export interface SessionSearchTask {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly ask: { readonly text: string };
  readonly clarifications: readonly { readonly text: string }[];
}

/**
 * Everything about one task a query is matched against, as one string.
 *
 * Newline-joined rather than space-joined so a query cannot bridge two fields: `"F12 done"` must not
 * match a task numbered `F12` whose status text merely ends in `done`, and a separator no query can
 * contain is what prevents it.
 */
export function sessionSearchTaskHaystack(task: SessionSearchTask): string {
  return [task.id, task.title, task.description, task.ask.text, ...task.clarifications.map(entry => entry.text)].join(
    '\n',
  );
}

/** Everything about one indexed file a query is matched against: its name and its path. */
export function sessionSearchFileHaystack(file: SessionFileIndexEntry): string {
  return `${file.name}\n${file.path}`;
}

/**
 * Does this haystack match this query?
 *
 * A case-folded substring test, and deliberately nothing cleverer: the reader's mental model of a search
 * box is "show me the rows containing what I typed", and a fuzzy or token-split match here would make the
 * daemon's answer differ from what a client's own highlighting shows. A blank query matches NOTHING
 * rather than everything — an empty box is a question that has not been asked yet, and answering it with
 * the whole session is the one result a reader can never act on.
 */
export function matchesSessionSearchQuery(haystack: string, query: string): boolean {
  const parsed = SessionSearchQuerySchema.safeParse(query);
  return parsed.success && haystack.toLowerCase().includes(normalizeSessionSearchQuery(parsed.data));
}

/** A safe, non-empty path relative to one session root. */
const SessionFileIndexPathSchema = z
  .string()
  .min(1)
  .max(MAX_SESSION_FILE_INDEX_PATH_LENGTH)
  .refine(path => {
    if (path.startsWith('/') || path.includes('\\') || hasControlCharacter(path)) return false;
    return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
  }, 'file index paths must be safe paths relative to the session root');

/** One indexed file: the path a read route accepts, and the basename a reader recognises. */
export const SessionFileIndexEntrySchema = z
  .object({
    /** Relative to the session root, exactly as the file read route takes it. */
    path: SessionFileIndexPathSchema,
    name: z.string().min(1).max(MAX_SESSION_FILE_INDEX_NAME_LENGTH),
  })
  .superRefine((entry, ctx) => {
    if (entry.name !== entry.path.split('/').at(-1)) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: 'file index names must equal the path basename' });
    }
  });
export type SessionFileIndexEntry = z.infer<typeof SessionFileIndexEntrySchema>;

/**
 * Whether the walk saw everything it was allowed to see.
 *
 * `partial` is a statement about the WALK, not about policy: it means work stopped before the tree was
 * exhausted, so a name absent from `files` may still exist.
 */
export const SessionFileIndexCoverageSchema = z.enum(['complete', 'partial']);
export type SessionFileIndexCoverage = z.infer<typeof SessionFileIndexCoverageSchema>;

/**
 * Why paths are missing from an index.
 *
 * `denied` is the unconditional secrets denylist; `excluded` is a metadata, dependency, generated,
 * vendor, build or cache root; and `unsupported` is anything that is not a current regular file — a
 * symlink, socket, device or deleted tracked path. None says searchable work stopped early. `unreadable`
 * is a subtree the daemon could not enumerate (a permission, or a directory that vanished mid-walk) and
 * `truncated` is a bound biting: those two are what make an index partial.
 */
export const SessionFileIndexSkipReasonSchema = z.enum([
  'denied',
  'excluded',
  'unsupported',
  'unreadable',
  'truncated',
]);
export type SessionFileIndexSkipReason = z.infer<typeof SessionFileIndexSkipReasonSchema>;

/**
 * How many paths one reason accounts for. A reason with nothing behind it is not reported at all.
 *
 * A `truncated` count is a FLOOR rather than a total, and that is not sloppiness: the daemon stopped
 * looking, so the number it did not reach cannot be known without doing the work the bound exists to
 * avoid. `coverage` is the field that says so; this number only says how much was already in hand.
 */
export const SessionFileIndexSkipSchema = z.object({
  reason: SessionFileIndexSkipReasonSchema,
  count: NonNegativeIntegerSchema.min(1),
});
export type SessionFileIndexSkip = z.infer<typeof SessionFileIndexSkipSchema>;

const SessionFileIndexShape = {
  /** The session root as PINNED by the daemon, never as configured. */
  root: z.string().min(1),
  files: z.array(SessionFileIndexEntrySchema).max(MAX_SESSION_FILE_INDEX_FILES),
  coverage: SessionFileIndexCoverageSchema,
  /** A TOTAL record of what was left out, one row per reason. */
  skipped: z.array(SessionFileIndexSkipSchema).max(SessionFileIndexSkipReasonSchema.options.length),
};

/** The reasons whose presence means the walk itself did not finish. */
const INCOMPLETE_SKIP_REASONS: readonly SessionFileIndexSkipReason[] = ['unreadable', 'truncated'];

/**
 * The two things an index document may not do: claim completeness over a walk that stopped early, and
 * report one reason twice.
 *
 * The first is the whole point of the coverage field — a producer that forgets to downgrade it turns a
 * partial answer into a confident wrong one, and only the schema is in a position to catch that on both
 * ends of the wire. The second keeps `skipped` a record a reader can sum: two `denied` rows read as two
 * separate refusals and invite a client to add them or to show the first.
 */
function refineSessionFileIndex(
  value: {
    readonly files: readonly SessionFileIndexEntry[];
    readonly coverage: SessionFileIndexCoverage;
    readonly skipped: readonly SessionFileIndexSkip[];
  },
  ctx: z.RefinementCtx,
): void {
  const paths = value.files.map(file => file.path);
  if (new Set(paths).size !== paths.length) {
    ctx.addIssue({ code: 'custom', path: ['files'], message: 'each indexed path may be reported at most once' });
  }
  const reasons = value.skipped.map(skip => skip.reason);
  if (new Set(reasons).size !== reasons.length) {
    ctx.addIssue({ code: 'custom', path: ['skipped'], message: 'each skip reason may be reported at most once' });
  }
  const incomplete = reasons.some(reason => INCOMPLETE_SKIP_REASONS.includes(reason));
  if (value.coverage === 'complete' && incomplete) {
    ctx.addIssue({
      code: 'custom',
      path: ['coverage'],
      message: 'an index that could not read or could not finish a subtree is partial, not complete',
    });
  }
  if (value.coverage === 'partial' && !incomplete) {
    ctx.addIssue({
      code: 'custom',
      path: ['coverage'],
      message: 'a partial index must name the unreadable or truncated work that made it partial',
    });
  }
}

/** One session's file index, as the daemon's own domain holds it. */
export const SessionFileIndexSchema = z.object(SessionFileIndexShape).superRefine(refineSessionFileIndex);
export type SessionFileIndex = z.infer<typeof SessionFileIndexSchema>;

export const SESSION_FILE_INDEX_VERSION = 1;

/**
 * The same index on the wire, stamped with the session it describes.
 *
 * There is deliberately no `updatedAt`. The route is served `no-store` and the walk runs inside the
 * request, so the answer is never older than the reader's own question — a timestamp here would be a
 * fact nothing consumes, bought by giving this surface a clock it otherwise has no reason to hold.
 */
export const SessionFileIndexResponseSchema = z
  .object({
    v: z.literal(SESSION_FILE_INDEX_VERSION),
    sessionId: z.string().min(1),
    ...SessionFileIndexShape,
  })
  .superRefine(refineSessionFileIndex);
export type SessionFileIndexResponse = z.infer<typeof SessionFileIndexResponseSchema>;
