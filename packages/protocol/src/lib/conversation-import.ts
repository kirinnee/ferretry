import { z } from 'zod';
import { InstantSchema } from './common.ts';
import { HarnessSchema, SessionStatusSchema } from './session-base.ts';

/**
 * Keeping an existing Claude Code / Codex conversation "on" as a ferret.
 *
 *   GET  /v1/imports/conversations[?source=&harness=&q=&since=&limit=]  what the CLIs already hold on this machine
 *        (searched on the daemon over its metadata index: text in the first/last user message or the
 *        project folder, where it is kept, a harness, an earliest last-activity; newest first)
 *   GET  /v1/imports/conversations/:harness/:id/preview  the last few exchanges of one, before continuing it
 *   POST /v1/imports/conversations/adopt                    one Ferretry session per chosen conversation
 *
 * A listing row is METADATA ONLY: the project folder, a preview of the first thing the owner typed,
 * when it was last active, how many turns it has, the model, and the session that already owns it.
 * The transcript itself never crosses the wire here and is never copied: an adopted session reads the
 * CLI's own file and resumes it with the CLI's own resume path, so Chat shows the same file. The one
 * exception is the preview of ONE conversation the owner asked about: its last few exchanges, each cut
 * short, so a row can be told apart from its neighbours before it is continued.
 *
 * Every route is governed (`fleet` configure): a listing reads the owner's local CLI data, and an
 * adoption creates sessions that can launch an agent.
 */
export const CONVERSATION_IMPORT_PATH = '/v1/imports/conversations';
export const CONVERSATION_ADOPT_PATH = '/v1/imports/conversations/adopt';

/** A conversation's name (its title) is cut to this many characters. */
export const CONVERSATION_NAME_MAX = 120;

/** The preview is the first user message cut to this many characters, never the transcript. */
export const CONVERSATION_PREVIEW_MAX = 120;
/** How many exchanges (an owner's message and the replies to it) a conversation preview shows. */
export const CONVERSATION_EXCHANGE_COUNT = 4;
/** Each message in a conversation preview is cut to this many characters. */
export const CONVERSATION_EXCHANGE_TEXT_MAX = 280;
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
  /**
   * The name the CLI gave it: Claude Code's `/rename` title, else its generated one; Codex's thread name.
   * Absent when the conversation was never named, which is when the first message stands in for it.
   */
  name: z.string().min(1).max(CONVERSATION_NAME_MAX).optional(),
  /** The first user message, whitespace-collapsed and truncated. */
  preview: z.string().max(CONVERSATION_PREVIEW_MAX),
  /** The most recent user message, the same way, when it differs from the first. */
  latest: z.string().min(1).max(CONVERSATION_PREVIEW_MAX).optional(),
  lastActivityAt: InstantSchema,
  /** How many times the owner spoke. */
  turns: z.number().int().nonnegative(),
  /**
   * Set when the conversation was too large for a listing to read whole: it was described from its
   * first and last few megabytes, so `turns` counts only the messages there and is a LOWER BOUND.
   */
  turnsAtLeast: z.literal(true).optional(),
  model: z.string().min(1).optional(),
  /** The Ferretry session that already owns this conversation; such a row cannot be picked again. */
  adoptedBy: z.string().min(1).optional(),
  /**
   * Where the file this row describes is kept: Ferretry's history, or only the computer's own home.
   * A row kept in both (an adopted one, hard-linked) says `ferretry`: that copy is the one used.
   */
  keptIn: z.enum(['ferretry', 'computer']).optional(),
});
export type ImportableConversation = z.infer<typeof ImportableConversationSchema>;

/**
 * Where a conversation is kept.
 *
 *   ferretry  Ferretry's own history: the shared pool every runtime's home reads and writes, which
 *             holds what Ferretry's sessions said and every conversation imported into it
 *   computer  the CLI's own home on this computer (`~/.claude`, `~/.codex`), which only importing reads
 */
export const ConversationSourceSchema = z.enum(['ferretry', 'computer']);
export type ConversationSource = z.infer<typeof ConversationSourceSchema>;

/**
 * What a listing may be asked to read. `ferretry` and `computer` name one place; `synced` is what
 * "Keep in sync" shows — Ferretry's history plus the computer's, unless the owner switched listing the
 * computer's off (Settings › Machine › Conversations). Absent is both places regardless of that setting.
 */
export const ConversationListSourceSchema = z.enum(['ferretry', 'computer', 'synced']);
export type ConversationListSource = z.infer<typeof ConversationListSourceSchema>;

/** The listing query, as the daemon parses it from the URL. Every field narrows; none widens. */
export const ConversationImportQuerySchema = z.strictObject({
  /** Only conversations kept there. Absent reads both, Ferretry's copy first. */
  source: ConversationListSourceSchema.optional(),
  harness: HarnessSchema.optional(),
  /** Case-insensitive words, each of which must appear in the name, the preview, the latest message or the folder. */
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
  /**
   * Set (to `false`) only on a `synced` listing taken while the owner has listing this computer's
   * conversations switched off, so a surface can say why none of them are here.
   */
  computerListed: z.literal(false).optional(),
});
export type ConversationImportListing = z.infer<typeof ConversationImportListingSchema>;

/** One message of a conversation preview: who said it, cleaned of delivery wrappers, and cut short. */
export const ConversationExchangeMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(CONVERSATION_EXCHANGE_TEXT_MAX),
});
export type ConversationExchangeMessage = z.infer<typeof ConversationExchangeMessageSchema>;

/** `GET …/:harness/:id/preview`: the last few exchanges, oldest first. */
export const ConversationPreviewSchema = z.strictObject({
  id: ImportConversationIdSchema,
  harness: HarnessSchema,
  messages: z.array(ConversationExchangeMessageSchema),
});
export type ConversationPreview = z.infer<typeof ConversationPreviewSchema>;

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

/** The windows "Import conversations" offers, in days: setup in the browser and `--since` on the CLI agree. */
export const CONVERSATION_IMPORT_WINDOW_DAYS = [1, 3, 7, 14, 30] as const;
export type ConversationImportWindowDays = (typeof CONVERSATION_IMPORT_WINDOW_DAYS)[number];

/** `7d` → 7; undefined for any duration the import does not offer. */
export const parseImportWindow = (text: string): ConversationImportWindowDays | undefined =>
  CONVERSATION_IMPORT_WINDOW_DAYS.find(days => `${days}d` === text.trim());

const DAY_MS = 86_400_000;

/**
 * The ids an import of `days` (or of everything, when `days` is undefined) would keep: rows no ferret owns
 * yet, active inside the window.
 */
export const conversationsToImport = (
  rows: readonly ImportableConversation[],
  days: number | undefined,
  now: number,
): readonly string[] =>
  rows
    .filter(
      row =>
        row.adoptedBy === undefined && (days === undefined || Date.parse(row.lastActivityAt) >= now - days * DAY_MS),
    )
    .map(row => row.id);

/** Splits ids into adoption-sized requests: one adoption may name at most `CONVERSATION_ADOPT_MAX`. */
export const adoptionBatches = (ids: readonly string[]): readonly (readonly string[])[] => {
  const batches: string[][] = [];
  for (let at = 0; at < ids.length; at += CONVERSATION_ADOPT_MAX)
    batches.push(ids.slice(at, at + CONVERSATION_ADOPT_MAX));
  return batches;
};

/** Where a throwaway run works: the system's temp folders, and a harness's scratch folder anywhere. */
const TEMP_ROOTS = ['/tmp/', '/private/tmp/', '/var/tmp/', '/var/folders/', '/private/var/folders/'] as const;
const SCRATCH_SEGMENTS = new Set(['scratch', 'scratchpad']);
/** A segment that is an id rather than a name: a UUID, or a long run of hex. */
const HASH_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,})$/iu;

/** A conversation's folder as a row says it: a short name, and whether it is a throwaway scratch folder. */
export interface ConversationFolder {
  /** The folder's own name, or `undefined` for a scratch folder whose name is only an id or "scratchpad". */
  readonly name: string | undefined;
  readonly scratch: boolean;
}

/**
 * The folder a row names: its last segment, never a hash path. A folder under the system's temp folders,
 * or inside a `scratch`/`scratchpad` folder, is marked scratch, and keeps a name only when its last
 * segment is one a person chose (`/tmp/wt-cart` → `wt-cart`; `…/<uuid>/scratchpad` → none).
 */
export const conversationFolder = (project: string): ConversationFolder => {
  const segments = project.split(/[\\/]+/u).filter(segment => segment !== '');
  const last = segments.at(-1);
  const scratch =
    TEMP_ROOTS.some(root => `${project.replace(/\\/gu, '/')}/`.startsWith(root)) ||
    segments.some(segment => SCRATCH_SEGMENTS.has(segment.toLowerCase()));
  if (last === undefined) return { name: project === '' ? undefined : project, scratch };
  const named = !scratch || !(SCRATCH_SEGMENTS.has(last.toLowerCase()) || HASH_SEGMENT.test(last));
  return { name: named ? last : undefined, scratch };
};
