/**
 * THE VERSIONS OF AN AGENDA ITEM (docs/agenda.md § Versions): every change to an item keeps the WHOLE item as it was
 * left, numbered from 1, in a store of its own beside the board. The board holds the item as it is now; this holds how
 * it got there, with no cap, so "what changed since I last looked" can be drawn from any two versions.
 */
import { z } from 'zod';
import { AgendaConversationEntrySchema, AgendaIdSchema, AgendaItemSchema, ResolvedAgendaItemSchema } from './agenda.ts';
import { InstantSchema, PositiveIntegerSchema } from './common.ts';

const VersionHeadShape = {
  version: PositiveIntegerSchema,
  at: InstantSchema,
  /** Who made the change: the owner, the ferret that raised the item, or the daemon. */
  by: z.enum(['owner', 'ferret', 'daemon']),
  /** What the change was, as the board names it (`created`, `replied`, `answered`, `merged`, …). */
  change: z.string().trim().min(1).max(40),
};

/** One version in a list: when it was made and by whom, not the item itself. */
export const AgendaVersionSummarySchema = z.strictObject({
  ...VersionHeadShape,
  lifecycle: z.enum(['active', 'addressed']),
});
export type AgendaVersionSummary = z.infer<typeof AgendaVersionSummarySchema>;

/** One version in full: the item exactly as that change left it. */
export const AgendaVersionSchema = z.union([
  z.strictObject({ ...VersionHeadShape, lifecycle: z.literal('active'), item: AgendaItemSchema }),
  z.strictObject({ ...VersionHeadShape, lifecycle: z.literal('addressed'), item: ResolvedAgendaItemSchema }),
]);
export type AgendaVersion = z.infer<typeof AgendaVersionSchema>;

/** `GET /v1/sessions/:sessionId/agenda/:id/versions`. */
export const AgendaVersionListSchema = z.strictObject({
  sessionId: z.string().min(1),
  id: AgendaIdSchema,
  /** The newest version's number; 0 when the item has none kept (an item from before versions, not yet changed). */
  latest: z.number().int().nonnegative(),
  /** The newest version THIS device has seen (`PUT …/seen`); absent when it has not marked one. */
  seen: PositiveIntegerSchema.optional(),
  versions: z.array(AgendaVersionSummarySchema),
});
export type AgendaVersionList = z.infer<typeof AgendaVersionListSchema>;

/** `PUT /v1/sessions/:sessionId/agenda/:id/seen`: the app opened the item at this version. */
export const AgendaSeenRequestSchema = z.strictObject({ version: PositiveIntegerSchema });
export type AgendaSeenRequest = z.infer<typeof AgendaSeenRequestSchema>;
export const AgendaSeenResponseSchema = z.strictObject({ seen: PositiveIntegerSchema });
export type AgendaSeenResponse = z.infer<typeof AgendaSeenResponseSchema>;

/** Maximum text in one wire fragment, measured in UTF-16 code units. */
export const MAX_AGENDA_CONVERSATION_FRAGMENT_LENGTH = 16384;

/** A text fragment from one entry. Concatenate fragments with the same index, including whitespace. */
export const AgendaConversationPageSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  index: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  entry: AgendaConversationEntrySchema.omit({ text: true })
    .extend({
      text: z.string().max(MAX_AGENDA_CONVERSATION_FRAGMENT_LENGTH),
    })
    .optional(),
  next: z.strictObject({ index: z.number().int().nonnegative(), offset: z.number().int().nonnegative() }).optional(),
});
export type AgendaConversationPage = z.infer<typeof AgendaConversationPageSchema>;

/** Query for the bounded conversation read, optionally at a frozen item version. */
export const AgendaConversationQuerySchema = z.strictObject({
  index: z.coerce.number().int().nonnegative().default(0),
  offset: z.coerce.number().int().nonnegative().default(0),
  version: z.coerce.number().int().positive().optional(),
});
