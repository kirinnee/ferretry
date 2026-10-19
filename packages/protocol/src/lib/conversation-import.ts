import { z } from 'zod';
import { InstantSchema } from './common.ts';
import { SessionStatusSchema } from './session.ts';
import { HarnessSchema } from './session-base.ts';

/**
 * Keeping an existing Claude Code / Codex conversation "on" as a ferret.
 *
 *   GET  /v1/imports/conversations[?harness=&q=&since=&limit=]  what the CLIs already hold on this machine
 *        (searched on the daemon over its metadata index: text in the first/last user message or the
 *        project folder, a harness, an earliest last-activity; newest first)
 *   POST /v1/imports/conversations/adopt                    one Ferretry session per chosen conversation
 *
 * A listing row is METADATA ONLY: the project folder, a preview of the first thing the owner typed,
 * when it was last active, how many turns it has, the model, and the session that already owns it.
 * The transcript itself never crosses the wire here and is never copied: an adopted session reads the
 * CLI's own file and resumes it with the CLI's own resume path, so Chat shows the same file.
 *
 * Both routes are governed (`fleet` configure): a listing reads the owner's local CLI data, and an
 * adoption creates sessions that can launch an agent.
 */
export const CONVERSATION_IMPORT_PATH = '/v1/imports/conversations';
export const CONVERSATION_ADOPT_PATH = '/v1/imports/conversations/adopt';

/** The preview is the first user message cut to this many characters, never the transcript. */
export const CONVERSATION_PREVIEW_MAX = 120;
/** The most conversations one adoption may name. */
export const CONVERSATION_ADOPT_MAX = 200;
/** The most conversations one adoption may LAUNCH, so a picker cannot start a burst of agents. */
export const CONVERSATION_LAUNCH_MAX = 10;

/** A harness conversation id: both CLIs use UUIDs, and the grammar keeps one from ever being a path. */
export const ImportConversationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);

export const ImportableConversationSchema = z.strictObject({
  /** The CLI's own conversation id, which is what its resume path takes. */
  id: ImportConversationIdSchema,
  harness: HarnessSchema,
  /** The absolute folder the conversation ran in, which is where a resumed ferret runs too. */
  project: z.string().min(1),
  /** The first user message, whitespace-collapsed and truncated. */
  preview: z.string().max(CONVERSATION_PREVIEW_MAX),
  /** The most recent user message, the same way, when it differs from the first. */
  latest: z.string().min(1).max(CONVERSATION_PREVIEW_MAX).optional(),
  lastActivityAt: InstantSchema,
  /** How many times the owner spoke. */
  turns: z.number().int().nonnegative(),
  model: z.string().min(1).optional(),
  /** The Ferretry session that already owns this conversation; such a row cannot be picked again. */
  adoptedBy: z.string().min(1).optional(),
});
export type ImportableConversation = z.infer<typeof ImportableConversationSchema>;

/** The listing query, as the daemon parses it from the URL. Every field narrows; none widens. */
export const ConversationImportQuerySchema = z.strictObject({
  harness: HarnessSchema.optional(),
  /** Case-insensitive words, each of which must appear in the preview, the latest message or the folder. */
  q: z.string().max(200).optional(),
  /** Only conversations active at or after this instant. */
  since: InstantSchema.optional(),
  limit: z.coerce.number().int().positive().max(5_000).optional(),
});
export type ConversationImportQuery = z.infer<typeof ConversationImportQuerySchema>;

export const ConversationImportListingSchema = z.strictObject({
  /** Newest first, after the query; at most `limit`. */
  conversations: z.array(ImportableConversationSchema),
  /** How many matched before `limit` cut the list. */
  matched: z.number().int().nonnegative(),
  /** Files that looked like conversations but carried no usable id, folder or message. */
  skipped: z.number().int().nonnegative(),
});
export type ConversationImportListing = z.infer<typeof ConversationImportListingSchema>;

export const ConversationAdoptItemSchema = z.strictObject({
  id: ImportConversationIdSchema,
  /** `true` launches it now; `false` (the default) adopts it as stopped, ready to resume later. */
  start: z.boolean().default(false),
});
export type ConversationAdoptItem = z.infer<typeof ConversationAdoptItemSchema>;

export const ConversationAdoptRequestSchema = z
  .strictObject({
    harness: HarnessSchema,
    /** The runtime (wrapper name) every adopted ferret runs on. It must drive `harness`. */
    runtime: z.string().min(1),
    conversations: z.array(ConversationAdoptItemSchema).min(1).max(CONVERSATION_ADOPT_MAX),
  })
  .refine(value => new Set(value.conversations.map(item => item.id)).size === value.conversations.length, {
    message: 'a conversation may be named only once',
    path: ['conversations'],
  })
  .refine(value => value.conversations.filter(item => item.start).length <= CONVERSATION_LAUNCH_MAX, {
    message: `at most ${CONVERSATION_LAUNCH_MAX} conversations may be started at once; adopt the rest as stopped`,
    path: ['conversations'],
  });
export type ConversationAdoptRequest = z.input<typeof ConversationAdoptRequestSchema>;

export const ConversationAdoptRefusalCodeSchema = z.enum([
  /** No such conversation on this machine (or it is no longer readable). */
  'not_found',
  /** A Ferretry session already owns it. */
  'already_adopted',
  /** The runtime does not drive this conversation's CLI. */
  'harness_mismatch',
  /** The runtime's history already holds a different file under this conversation's name. */
  'conflict',
  /** The runtime cannot reach the file (another disk, or no history folder). */
  'unavailable',
  /** The session could not be created or launched. */
  'failed',
]);
export type ConversationAdoptRefusalCode = z.infer<typeof ConversationAdoptRefusalCodeSchema>;

export const ConversationAdoptedSchema = z.strictObject({
  id: ImportConversationIdSchema,
  session: z.string().min(1),
  /** The ferret's name. */
  name: z.string().min(1),
  status: SessionStatusSchema,
});
export type ConversationAdopted = z.infer<typeof ConversationAdoptedSchema>;

export const ConversationAdoptRefusedSchema = z.strictObject({
  id: ImportConversationIdSchema,
  code: ConversationAdoptRefusalCodeSchema,
  reason: z.string().min(1),
});
export type ConversationAdoptRefused = z.infer<typeof ConversationAdoptRefusedSchema>;

export const ConversationAdoptResultSchema = z.strictObject({
  adopted: z.array(ConversationAdoptedSchema),
  refused: z.array(ConversationAdoptRefusedSchema),
});
export type ConversationAdoptResult = z.infer<typeof ConversationAdoptResultSchema>;
