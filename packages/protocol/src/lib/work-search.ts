import { z } from 'zod';
import { AgendaIdSchema } from './agenda.ts';
import { BoardProjectIdSchema, BoardTaskIdSchema } from './board-refs.ts';
import { InstantSchema, NonNegativeIntegerSchema } from './common.ts';

/**
 * WORK SEARCH — one search over the board's cards and the agenda's items, across every project and every
 * session (docs/work-search.md).
 *
 * WHY ONE INDEX AND NOT TWO FILTERS. A ferret about to file a card asks "is this already somebody's?",
 * and the answer is as often an agenda item as a card. Two searches with two rankings make the reader
 * merge them by eye, so the daemon owns one index, one ranking and one notion of "strongly related", and
 * the CLI, the agent tool and the PWA all ask the same question of it.
 *
 * WHAT IS IN IT. Only text the owner already sees on a card or an item, after the secret redactor, open
 * work and work closed within {@link WORK_SEARCH_CLOSED_WINDOW_DAYS}. An answer carries the line that
 * matched, never the whole document: a search is a way to FIND a card, and reading it is the card's own
 * route, with that route's grants.
 */

export const WORK_SEARCH_PATH = '/v1/search' as const;
export const WORK_RELATED_PATH = '/v1/search/related' as const;

/** Longest query accepted at a boundary; beyond it a query is refused, never truncated. */
export const MAX_WORK_SEARCH_QUERY_LENGTH = 200;
/** The most hits one answer carries. */
export const MAX_WORK_SEARCH_LIMIT = 50;
export const DEFAULT_WORK_SEARCH_LIMIT = 20;
/** How long closed, dropped and addressed work stays findable. */
export const WORK_SEARCH_CLOSED_WINDOW_DAYS = 30;
/** Longest title and ask a related check weighs. */
export const MAX_WORK_RELATED_TEXT_LENGTH = 4000;
/** The most related matches one check returns. */
export const MAX_WORK_RELATED_HITS = 5;

export const WorkKindSchema = z.enum(['task', 'agenda']);
export type WorkKind = z.infer<typeof WorkKindSchema>;

/**
 * Where a piece of work stands, in one vocabulary for both kinds: `open` is anything still to do (any
 * non-closed lane; an active agenda item), `closed` is a closed lane or an addressed item, `dropped` is a
 * dropped card.
 */
export const WorkStateSchema = z.enum(['open', 'closed', 'dropped']);
export type WorkState = z.infer<typeof WorkStateSchema>;

/** Which text a hit matched, so a reader can tell a title hit from a passing mention in a note. */
export const WorkFieldSchema = z.enum([
  'id',
  'title',
  'summary',
  'ask',
  'premise',
  'context',
  'brief',
  'howToTest',
  'note',
  'body',
  'history',
  'resolution',
]);
export type WorkField = z.infer<typeof WorkFieldSchema>;

export const WorkSearchQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(MAX_WORK_SEARCH_QUERY_LENGTH),
  kind: WorkKindSchema.optional(),
  /** Only open work. */
  open: z.boolean().default(false),
  /** One project's cards (agenda items have no project and are kept). */
  project: BoardProjectIdSchema.optional(),
  limit: z.number().int().min(1).max(MAX_WORK_SEARCH_LIMIT).default(DEFAULT_WORK_SEARCH_LIMIT),
});
export type WorkSearchQuery = z.infer<typeof WorkSearchQuerySchema>;
export type WorkSearchQueryInput = z.input<typeof WorkSearchQuerySchema>;

const WorkHitBaseSchema = {
  /** The session that owns it: a card's owner, an agenda item's ledger. */
  sessionId: z.string().min(1).nullable(),
  title: z.string(),
  state: WorkStateSchema,
  /** What the owner sees it as: the lane's name, or the agenda item's standing (`open`, `snoozed`, `addressed`). */
  standing: z.string().min(1),
  updatedAt: InstantSchema,
  /** The field that matched, and its one matching line (trimmed around the match). */
  match: z.strictObject({ field: WorkFieldSchema, line: z.string() }),
  score: z.number().nonnegative(),
};

export const WorkHitSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('task'),
    id: BoardTaskIdSchema,
    projectId: BoardProjectIdSchema,
    ...WorkHitBaseSchema,
  }),
  z.strictObject({
    kind: z.literal('agenda'),
    /** Per session: `A3` names an item only together with its `sessionId`. */
    id: AgendaIdSchema,
    ...WorkHitBaseSchema,
    sessionId: z.string().min(1),
  }),
]);
export type WorkHit = z.infer<typeof WorkHitSchema>;

export const WorkSearchResponseSchema = z.strictObject({
  hits: z.array(WorkHitSchema).max(MAX_WORK_SEARCH_LIMIT),
  /** Every match, before the limit. */
  total: NonNegativeIntegerSchema,
  /** How much the index holds, so an empty answer over an empty index reads as such. */
  indexed: z.strictObject({ tasks: NonNegativeIntegerSchema, agenda: NonNegativeIntegerSchema }),
});
export type WorkSearchResponse = z.infer<typeof WorkSearchResponseSchema>;

/** "Is what I am about to file already somebody's?" — the new title and ask, weighed against open work. */
export const WorkRelatedRequestSchema = z.strictObject({
  kind: WorkKindSchema,
  title: z.string().trim().min(1).max(MAX_WORK_RELATED_TEXT_LENGTH),
  ask: z.string().trim().max(MAX_WORK_RELATED_TEXT_LENGTH).optional(),
});
export type WorkRelatedRequest = z.infer<typeof WorkRelatedRequestSchema>;

/**
 * `strong` — near enough that filing a new one is probably a duplicate: the CLI refuses without `--new`.
 * `weak` — worth a look. The threshold is the daemon's, so every client draws the line in one place.
 */
export const WorkRelatedStrengthSchema = z.enum(['strong', 'weak']);
export type WorkRelatedStrength = z.infer<typeof WorkRelatedStrengthSchema>;

export const WorkRelatedResponseSchema = z.strictObject({
  matches: z
    .array(z.strictObject({ strength: WorkRelatedStrengthSchema, hit: WorkHitSchema }))
    .max(MAX_WORK_RELATED_HITS),
});
export type WorkRelatedResponse = z.infer<typeof WorkRelatedResponseSchema>;
