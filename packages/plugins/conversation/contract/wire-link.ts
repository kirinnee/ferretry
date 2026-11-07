/**
 * Links (§6.2): a conversation read from the harness's own file, not copied. Today's `conversation-import.ts`,
 * renamed (import -> link, adopt -> keep). Routes keep today's `/v1/imports/...` paths (parity); the words are new.
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';

export const CONVERSATION_NAME_MAX = 120;
export const CONVERSATION_PREVIEW_MAX = 120;
/** How many exchanges (an owner message and the replies to it) a preview shows. */
export const CONVERSATION_EXCHANGE_COUNT = 4;
export const CONVERSATION_EXCHANGE_TEXT_MAX = 280;
export const CONVERSATION_KEEP_MAX = 200;
export const CONVERSATION_LAUNCH_MAX = 10;

/** A harness's own conversation id (a uuid or a slug); also a ledger key. */
export const LinkIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
export type LinkId = z.infer<typeof LinkIdSchema>;

/** The harness plugin's id (`claude-code`, `codex`). */
const HarnessIdSchema = z.string().min(1);

export const LinkableConversationSchema = z.strictObject({
  id: LinkIdSchema,
  harness: HarnessIdSchema,
  project: z.string().min(1),
  name: z.string().min(1).max(CONVERSATION_NAME_MAX).optional(),
  preview: z.string().max(CONVERSATION_PREVIEW_MAX),
  latest: z.string().min(1).max(CONVERSATION_PREVIEW_MAX).optional(),
  lastActivityAt: InstantSchema,
  turns: z.number().int().nonnegative(),
  turnsAtLeast: z.literal(true).optional(),
  model: z.string().min(1).optional(),
  keptBy: z.string().min(1).optional(),
  keptIn: z.enum(['ferretry', 'computer']).optional(),
});
export type LinkableConversation = z.infer<typeof LinkableConversationSchema>;

export const LinkListSourceSchema = z.enum(['ferretry', 'computer', 'synced']);

export const LinkQuerySchema = z.strictObject({
  source: LinkListSourceSchema.optional(),
  harness: HarnessIdSchema.optional(),
  q: z.string().max(200).optional(),
  since: InstantSchema.optional(),
  limit: z.coerce.number().int().positive().max(5_000).optional(),
});
export type LinkQuery = z.infer<typeof LinkQuerySchema>;

export const LinkListingSchema = z.strictObject({
  conversations: z.array(LinkableConversationSchema),
  matched: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  computerListed: z.literal(false).optional(),
});
export type LinkListing = z.infer<typeof LinkListingSchema>;

export const ExchangeMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(CONVERSATION_EXCHANGE_TEXT_MAX),
});

export const LinkPreviewSchema = z.strictObject({
  id: LinkIdSchema,
  harness: HarnessIdSchema,
  messages: z.array(ExchangeMessageSchema),
});
export type LinkPreview = z.infer<typeof LinkPreviewSchema>;

/** One conversation to keep. It is read where the harness keeps it (a link); `copy` asks for Ferretry's own copy of the file instead (owner choice Q19: link by default, copy on request). */
export const KeepItemSchema = z.strictObject({
  id: LinkIdSchema,
  start: z.boolean().default(false),
  copy: z.boolean().optional(),
});

/** `POST /v1/imports/conversations/adopt`: keep these conversations as ferrets. */
export const KeepRequestSchema = z
  .strictObject({
    harness: HarnessIdSchema,
    runtime: z.string().min(1),
    conversations: z.array(KeepItemSchema).min(1).max(CONVERSATION_KEEP_MAX),
  })
  .refine(value => new Set(value.conversations.map(item => item.id)).size === value.conversations.length, {
    message: 'a conversation may be named only once',
    path: ['conversations'],
  })
  .refine(value => value.conversations.filter(item => item.start).length <= CONVERSATION_LAUNCH_MAX, {
    message: `at most ${CONVERSATION_LAUNCH_MAX} conversations may be started at once; keep the rest as stopped`,
    path: ['conversations'],
  });
export type KeepRequest = z.input<typeof KeepRequestSchema>;

export const KeepRefusalCodeSchema = z.enum([
  'not_found',
  'already_kept',
  'harness_mismatch',
  'conflict',
  'unavailable',
  'failed',
]);

export const KeptSchema = z.strictObject({
  id: LinkIdSchema,
  ferret: FerretIdSchema,
  name: z.string().min(1),
  state: z.enum(['starting', 'working', 'idle', 'stopped']),
});
export const KeepRefusedSchema = z.strictObject({
  id: LinkIdSchema,
  code: KeepRefusalCodeSchema,
  reason: z.string().min(1),
});
export const KeepResultSchema = z.strictObject({
  kept: z.array(KeptSchema),
  refused: z.array(KeepRefusedSchema),
});
export type KeepResult = z.infer<typeof KeepResultSchema>;

/** `GET /v1/imports/history[/:importId]`: the read-only foreign history of a harness (today's `foreign-history`). */
export const ForeignHistoryEntrySchema = z.strictObject({
  id: z.string().min(1),
  harness: HarnessIdSchema,
  title: z.string().optional(),
  at: InstantSchema,
});
export const ForeignHistoryListSchema = z.strictObject({ entries: z.array(ForeignHistoryEntrySchema) });
export const ForeignHistorySchema = z.strictObject({
  entry: ForeignHistoryEntrySchema,
  messages: z.array(ExchangeMessageSchema),
});

/** `state/conversation/links.json`: which conversations a ferret reads from the harness's own file. */
export const LinksFileSchema = z.strictObject({
  format: z.literal(1),
  links: z.array(
    z.strictObject({
      id: LinkIdSchema,
      harness: HarnessIdSchema,
      ferret: FerretIdSchema,
      linkedAt: InstantSchema,
      /** Ferretry made its own copy of the file (the owner asked); absent means it is read where the harness keeps it. */
      copied: z.literal(true).optional(),
    }),
  ),
});
/**
 * `finder.json`: a cache of where each harness keeps each conversation's file, so a listing does not walk every
 * folder again. Harness → conversation id → the file's path below the harness's history root.
 */
export const FinderFileSchema = z.strictObject({
  format: z.literal(1),
  files: z.record(z.string(), z.record(z.string(), z.string())),
});
export type FinderFile = z.infer<typeof FinderFileSchema>;

export type LinksFile = z.infer<typeof LinksFileSchema>;
