/** Reading a ferret's conversation: transcript pages, logs, search inside one, images (today's `session-transcript.ts`). */
import { InstantSchema, JsonValueSchema } from '@ferretry/std';
import { z } from 'zod';
import { FerretIdSchema } from '@ferretry/core-ferrets/contract';

/**
 * One transcript message. `point` and `selectionBinding` are opaque strings the harness's `TranscriptReader` mints
 * (today's `ExactConversationMessagePointSchema`); Conversation only carries them.
 */
export const TranscriptMessageSchema = z.strictObject({
  point: z.string().min(1),
  role: z.enum(['user', 'assistant', 'developer', 'system']),
  text: z.string(),
  timestamp: InstantSchema.optional(),
  selectionBinding: z.string().min(1),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;

export const TranscriptPageSchema = z.strictObject({
  v: z.literal(1),
  ferret: FerretIdSchema,
  messages: z.array(TranscriptMessageSchema).readonly(),
  nextCursor: z.string().min(1).nullable(),
  previousCursor: z.string().min(1).nullable().optional(),
});
export type TranscriptPage = z.infer<typeof TranscriptPageSchema>;

const EventRoleSchema = z.enum(['user', 'assistant', 'developer', 'system', 'tool']);

/**
 * One event of a ferret's transcript tail, in the order the harness wrote it: a message, a tool call the ferret made, or
 * the result that came back. This is the tail a CHECK reads (what a turn did: a PR it opened, a command it ran), where
 * `TranscriptMessageSchema` is the page a person reads (messages only, each bound to a cursor token). Every string in it,
 * a tool call's input and a tool result's content included, has been through the read-scoped redaction.
 */
export const TranscriptEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('message'),
    role: EventRoleSchema,
    text: z.string(),
    timestamp: InstantSchema.optional(),
    /** `harness` is text the harness wrote into the user channel itself: never something the owner said. */
    inputSource: z.enum(['native-queue', 'harness']).optional(),
  }),
  z.strictObject({
    kind: z.literal('tool-call'),
    role: EventRoleSchema,
    timestamp: InstantSchema.optional(),
    call: z.strictObject({ id: z.string().min(1), name: z.string().min(1), input: JsonValueSchema }),
  }),
  z.strictObject({
    kind: z.literal('tool-result'),
    role: EventRoleSchema,
    timestamp: InstantSchema.optional(),
    result: z.strictObject({
      callId: z.string().min(1),
      content: JsonValueSchema,
      text: z.string().optional(),
      isError: z.boolean(),
    }),
  }),
]);
export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>;

/** The newest events of a ferret's transcript, oldest first (`ConversationApi.transcriptEvents`). */
export const TranscriptEventTailSchema = z.strictObject({
  v: z.literal(1),
  ferret: FerretIdSchema,
  events: z.array(TranscriptEventSchema).readonly(),
});
export type TranscriptEventTail = z.infer<typeof TranscriptEventTailSchema>;

export interface TranscriptEventsOptions {
  /** How many of the newest events; the transcript's own bound when absent. */
  readonly limit?: number;
}

/**
 * What the owner said to a ferret: every message of theirs, from the queue, the send ledger and the turn documents
 * (`ConversationApi.ownerWords`). A message with a recorded author is the owner's only when that record says so; one
 * with none is the owner's less any paragraph that is Ferretry's own notice.
 */
export const OwnerWordsSchema = z.strictObject({
  v: z.literal(1),
  ferret: FerretIdSchema,
  words: z.array(z.string()).readonly(),
});
export type OwnerWords = z.infer<typeof OwnerWordsSchema>;

export interface OwnerWordsOptions {
  /**
   * Refuse rather than guess. A best-effort read answers with whatever it could read; a strict one fails when any record
   * could not be read or was damaged, so a caller deciding something permanent never takes "nobody spoke" for "nothing
   * could be read".
   */
  readonly strict?: boolean;
}

/** Log pages are whole records meeting at `start`; a stale file token is `409 log_cursor_stale` (R266, kept half). */
export const LogPageSchema = z.strictObject({
  v: z.literal(1),
  ferret: FerretIdSchema,
  log: z.string(),
  start: z.number().int().nonnegative(),
  file: z.string().min(1),
  offsets: z.array(z.number().int().nonnegative()).readonly().optional(),
});
export type LogPage = z.infer<typeof LogPageSchema>;

export const LogSearchMatchSchema = z.strictObject({
  offset: z.number().int().nonnegative(),
  role: z.string().min(1),
  kind: z.string().min(1),
  snippet: z.string(),
  at: z.string().optional(),
});

export const LogSearchSchema = z.strictObject({
  v: z.literal(1),
  ferret: FerretIdSchema,
  query: z.string().min(1),
  file: z.string().min(1),
  matches: z.array(LogSearchMatchSchema).readonly(),
  truncated: z.boolean(),
});
export type LogSearch = z.infer<typeof LogSearchSchema>;

export interface LogSearchOptions {
  readonly who?: 'all' | 'me' | 'agent';
  readonly tools?: boolean;
  readonly limit?: number;
}
export interface LogPageOptions {
  readonly before?: number;
  readonly from?: number;
  readonly limit?: number;
  readonly file?: string;
}
export interface MessagesTailOptions {
  readonly through?: string;
  readonly limit?: number;
}

export const TRANSCRIPT_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const IMAGE_HANDLE = /^[A-Za-z0-9_-]{8,128}$/u;

/**
 * The answer for one transcript image: its bytes as padded base64 and the type read from the bytes themselves, never
 * the transcript's claim (G162: a handle addresses only a record re-parsed by the harness parser).
 */
export const TranscriptImageDownloadSchema = z.strictObject({
  image: z.strictObject({
    handle: z.string().regex(IMAGE_HANDLE),
    mediaType: z.enum(TRANSCRIPT_IMAGE_MEDIA_TYPES),
    byteLength: z.number().int().positive(),
  }),
  base64: z.string().min(4),
});
export type TranscriptImageDownload = z.infer<typeof TranscriptImageDownloadSchema>;

/** `GET /v1/ferrets/:ferretId/handoffs/:name`: a turn's hand-off note (today's `SessionHandoff`, reduced to its text). */
export const HandoffSchema = z.strictObject({
  v: z.literal(1),
  ferret: FerretIdSchema,
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u),
  text: z.string(),
});
export type Handoff = z.infer<typeof HandoffSchema>;
