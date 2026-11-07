/** Reading a ferret's conversation: transcript pages, logs, search inside one, images (today's `session-transcript.ts`). */
import { InstantSchema, JsonValueSchema, NonNegativeIntegerSchema } from '@ferretry/std';
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

/**
 * The newest events of a ferret's transcript as ONE masked text, every kind rendered as the operator's log reads it —
 * messages, reasoning, tool calls and results, usage, turn markers, compactions, errors, attachments
 * (`ConversationApi.transcriptLog`).
 */
export const TranscriptLogTailSchema = z.strictObject({
  v: z.literal(1),
  ferret: FerretIdSchema,
  log: z.string(),
});
export type TranscriptLogTail = z.infer<typeof TranscriptLogTailSchema>;

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

/**
 * AN IMAGE IN A FERRET'S TRANSCRIPT, AS SOMETHING A CHAT CAN ASK FOR.
 *
 * The chat reads a ferret's transcript as the text of `GET /v1/ferrets/:ferretId/logs`, and an image does
 * not fit in text: a pasted screenshot is megabytes of base64 the daemon deliberately never parses
 * (`packages/daemon/src/lib/transcript/large-strings.ts`). So the log carries a MARKER where an image
 * was, and the marker names a HANDLE the daemon resolves back to the image's bytes on request.
 *
 * A HANDLE NAMES A RECORD, NEVER A BYTE RANGE. It is the byte offset and length of the one transcript
 * record the image is in, plus which image of that record it is. The daemon re-reads that record,
 * proves it IS a whole record its parser emitted, and takes the image's bytes from what the parser
 * found there — so a caller can never point the route at arbitrary bytes of the file, only at an image
 * the ferret actually holds. The ordinal counts images in the order {@link TranscriptImageHandle}'s
 * producer walks the record's events: attachments and tool-result image blocks alike, one owner
 * (`packages/daemon/src/lib/transcript/images.ts`), which both the log renderer and the route call.
 *
 * THE MARKER IS ADDITIVE. An attachment line still starts with its kind (`image`), and a client that
 * does not know markers reads `image [fy-image 4096.3145728.0 image/png]` as the same word plus a
 * bracket it shows or hides as before.
 *
 * THE ANSWER IS TEXT. Every carrier — direct included — crosses the session tunnel, whose answer
 * body is a string (docs/relay-protocol.md, `res`), so the route answers JSON with the image's base64,
 * like the attachment download does, and the tunnel splits a large one into parts.
 */
/** The image types a chat paints. Anything else in a transcript stays a text label. */
export type TranscriptImageMediaType = (typeof TRANSCRIPT_IMAGE_MEDIA_TYPES)[number];

/** The largest record a handle may name: the daemon's own transcript read bound. */
export const MAX_TRANSCRIPT_IMAGE_RECORD_BYTES = 32 * 1024 * 1024;
/** More images than this in one record is not a transcript, it is an attack on the walk. */
export const MAX_TRANSCRIPT_IMAGE_ORDINAL = 255;

export interface TranscriptImageHandle {
  /** Where the record starts in the session's transcript file. */
  readonly recordOffset: number;
  /** The record's length in bytes, excluding its newline. */
  readonly recordLength: number;
  /** Which image of the record, from 0. */
  readonly ordinal: number;
}

const HANDLE = /^(0|[1-9][0-9]{0,15})\.([1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,2})$/u;

/** `4096.3145728.0`: record offset, record length, ordinal. */
export const formatTranscriptImageHandle = (handle: TranscriptImageHandle): string =>
  `${String(handle.recordOffset)}.${String(handle.recordLength)}.${String(handle.ordinal)}`;

/** The handle `text` spells, or `undefined` for anything that is not exactly one. Total. */
export const parseTranscriptImageHandle = (text: string): TranscriptImageHandle | undefined => {
  const match = HANDLE.exec(text);
  if (match === null) return undefined;
  const recordOffset = Number(match[1]);
  const recordLength = Number(match[2]);
  const ordinal = Number(match[3]);
  if (!Number.isSafeInteger(recordOffset) || !Number.isSafeInteger(recordOffset + recordLength)) return undefined;
  if (recordLength > MAX_TRANSCRIPT_IMAGE_RECORD_BYTES || ordinal > MAX_TRANSCRIPT_IMAGE_ORDINAL) return undefined;
  return { recordOffset, recordLength, ordinal };
};

export const isTranscriptImageMediaType = (value: unknown): value is TranscriptImageMediaType =>
  (TRANSCRIPT_IMAGE_MEDIA_TYPES as readonly unknown[]).includes(value);

/** One image a log line names. `mediaType` is what the transcript declared: a hint, never proof. */
export interface TranscriptImageMarker {
  readonly handle: TranscriptImageHandle;
  readonly mediaType?: TranscriptImageMediaType;
}

const MARKER_PREFIX = '[fy-image ';
const MARKER = /\[fy-image ([0-9.]+) ([a-z/-]+)\]/gu;

/** `[fy-image 4096.3145728.0 image/png]`; an undeclared or unknown type is spelled `-`. */
export const formatTranscriptImageMarker = (marker: TranscriptImageMarker): string =>
  `${MARKER_PREFIX}${formatTranscriptImageHandle(marker.handle)} ${marker.mediaType ?? '-'}]`;

/**
 * `text` with every well-formed marker taken out, and the images they named in order. A malformed
 * marker is left in the text as it was: it is somebody's words, not ours. Whitespace a marker leaves
 * at the end of a line or of the text is trimmed so a marker-only line disappears.
 */
export const splitTranscriptImageMarkers = (
  text: string,
): { readonly text: string; readonly images: readonly TranscriptImageMarker[] } => {
  if (!text.includes(MARKER_PREFIX)) return { text, images: [] };
  const images: TranscriptImageMarker[] = [];
  const stripped = text.replace(MARKER, (whole, spelled: string, type: string) => {
    const handle = parseTranscriptImageHandle(spelled);
    if (handle === undefined || (type !== '-' && !isTranscriptImageMediaType(type))) return whole;
    images.push(type === '-' ? { handle } : { handle, mediaType: type as TranscriptImageMediaType });
    return '';
  });
  if (images.length === 0) return { text, images };
  return {
    text: stripped
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
      .replace(/\n+$/u, '')
      .trimEnd(),
    images,
  };
};

/** The route one image is read from. The handle is URL-safe by construction. */
export const transcriptImagePath = (ferretId: string, handle: TranscriptImageHandle): string =>
  `/v1/ferrets/${encodeURIComponent(ferretId)}/transcript-images/${formatTranscriptImageHandle(handle)}`;
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

/**
 * A CONTEXT COMPACTION, running or just finished — the second thing a `live` frame can carry.
 *
 * CLAUDE CODE REPORTS HOW FAR IT HAS GOT; CODEX DOES NOT. Current Claude Code paints a progress bar with a
 * whole percentage under its `Compacting conversation…` line, and a `↓ 37.4k tokens` figure in the clock's
 * parenthetical. When the daemon read them they ride on the frame as `percent` (0–100, the harness's
 * own reading) and `tokensWritten`. Older Claude Code and Codex paint only a clock, so both are ABSENT
 * and a reader shows a spinner, the clock and the usual duration (`expectedMs`, with the `basis` it came
 * from) — it NEVER derives a percentage of its own, because a made-up bar is a lie about a measurement.
 *
 * Every running compaction also carries FACTS the daemon measured: when it began and the context size it
 * began from.
 *
 * `done` is read back off the transcript (the harness's own boundary record), so it survives a
 * reload and a reconnect for as long as the record is inside the tail the daemon reads. `tokensAfter`
 * is optional because a harness only states the post-compaction context on its NEXT model call.
 */
export const FerretCompactionBasisSchema = z.enum(['history', 'typical']);
export type FerretCompactionBasis = z.infer<typeof FerretCompactionBasisSchema>;

export const FerretCompactionRunningSchema = z.strictObject({
  phase: z.literal('running'),
  /** When the daemon first saw the harness compacting. */
  startedAt: InstantSchema,
  /** The context size the compaction began from, when the transcript stated one. */
  tokensBefore: NonNegativeIntegerSchema.optional(),
  /** How far along the harness itself says it is, whole percent 0–100. Absent when the harness paints no bar. */
  percent: z.number().int().min(0).max(100).optional(),
  /** Tokens the harness says the compaction has written so far (↓). Absent when it paints no counter. */
  tokensWritten: NonNegativeIntegerSchema.optional(),
  /** How long a compaction usually takes here, in milliseconds — shown only when no real percent exists. */
  expectedMs: z.number().int().positive(),
  /** `history`: this daemon's own past compactions. `typical`: no history yet; a fixed prior. */
  basis: FerretCompactionBasisSchema,
});
export type FerretCompactionRunning = z.infer<typeof FerretCompactionRunningSchema>;

export const FerretCompactionDoneSchema = z.strictObject({
  phase: z.literal('done'),
  /** Who asked: the harness's own record says; absent when it did not. */
  trigger: z.enum(['manual', 'auto']).optional(),
  /** When the daemon saw it begin; absent when it only ever saw the end. */
  startedAt: InstantSchema.optional(),
  endedAt: InstantSchema,
  tokensBefore: NonNegativeIntegerSchema.optional(),
  tokensAfter: NonNegativeIntegerSchema.optional(),
});
export type FerretCompactionDone = z.infer<typeof FerretCompactionDoneSchema>;

export const FerretCompactionSchema = z.discriminatedUnion('phase', [
  FerretCompactionRunningSchema,
  FerretCompactionDoneSchema,
]);
export type FerretCompaction = z.infer<typeof FerretCompactionSchema>;

/** Tokens a finished compaction freed, when both ends are known and the context did shrink. */
export const compactionFreed = (done: FerretCompactionDone): number | undefined =>
  done.tokensBefore === undefined || done.tokensAfter === undefined || done.tokensAfter > done.tokensBefore
    ? undefined
    : done.tokensBefore - done.tokensAfter;
