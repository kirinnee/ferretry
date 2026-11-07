/** Searching work and a ferret's own words (today's `work-search.ts`, `session-search.ts`). */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';

const NonNegativeInteger = z.number().int().nonnegative();

export const MAX_WORK_SEARCH_QUERY_LENGTH = 200;
export const MAX_WORK_SEARCH_LIMIT = 50;
export const DEFAULT_WORK_SEARCH_LIMIT = 20;
export const WORK_SEARCH_CLOSED_WINDOW_DAYS = 30;
export const MAX_WORK_RELATED_TEXT_LENGTH = 4000;
export const MAX_WORK_RELATED_HITS = 5;

/** `card` is today's `task`; `ask` is today's `agenda` item (words of §1). Ids stay plain strings: Board and Asks own them. */
export const WorkKindSchema = z.enum(['card', 'ask']);
export type WorkKind = z.infer<typeof WorkKindSchema>;
export const WorkStateSchema = z.enum(['open', 'closed', 'dropped']);
export const WorkFieldSchema = z.enum([
  'id',
  'title',
  'summary',
  'ask',
  'premise',
  'context',
  'brief',
  'howToTest',
  'progress',
  'note',
  'body',
  'history',
  'resolution',
]);

export const WorkSearchQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(MAX_WORK_SEARCH_QUERY_LENGTH),
  kind: WorkKindSchema.optional(),
  open: z.boolean().default(false),
  all: z.boolean().optional(),
  project: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_WORK_SEARCH_LIMIT).default(DEFAULT_WORK_SEARCH_LIMIT),
});
export type WorkSearchQuery = z.infer<typeof WorkSearchQuerySchema>;

const hitBase = {
  id: z.string().min(1),
  title: z.string(),
  state: WorkStateSchema,
  standing: z.string().min(1),
  updatedAt: InstantSchema,
  match: z.strictObject({ field: WorkFieldSchema, line: z.string() }),
  score: z.number().nonnegative(),
};
export const WorkHitSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('card'),
    project: z.string().min(1),
    ferret: z.string().min(1).nullable(),
    ...hitBase,
  }),
  z.strictObject({ kind: z.literal('ask'), ferret: z.string().min(1), ...hitBase }),
]);
export type WorkHit = z.infer<typeof WorkHitSchema>;

export const WorkSearchResponseSchema = z.strictObject({
  hits: z.array(WorkHitSchema).max(MAX_WORK_SEARCH_LIMIT),
  total: NonNegativeInteger,
  indexed: z.strictObject({ cards: NonNegativeInteger, asks: NonNegativeInteger }),
  olderHidden: NonNegativeInteger.optional(),
});
export type WorkSearchResponse = z.infer<typeof WorkSearchResponseSchema>;

export const WorkRelatedRequestSchema = z.strictObject({
  kind: WorkKindSchema,
  title: z.string().trim().min(1).max(MAX_WORK_RELATED_TEXT_LENGTH),
  ask: z.string().trim().max(MAX_WORK_RELATED_TEXT_LENGTH).optional(),
});
export type WorkRelatedRequest = z.infer<typeof WorkRelatedRequestSchema>;

export const WorkRelatedResponseSchema = z.strictObject({
  matches: z
    .array(z.strictObject({ strength: z.enum(['strong', 'weak']), hit: WorkHitSchema }))
    .max(MAX_WORK_RELATED_HITS),
});
export type WorkRelatedResponse = z.infer<typeof WorkRelatedResponseSchema>;

/** The `search_work` agent tool's input (today's MCP schema). */
export const SearchWorkToolInputSchema = z.strictObject({
  query: z.string().min(1).max(MAX_WORK_SEARCH_QUERY_LENGTH),
  kind: WorkKindSchema.optional(),
  open: z.boolean().optional(),
  all: z.boolean().optional(),
});
