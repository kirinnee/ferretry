/**
 * AN IMAGE IN A SESSION'S TRANSCRIPT, AS SOMETHING A CHAT CAN ASK FOR.
 *
 * The chat reads a session's transcript as the text of `GET /v1/sessions/:id/logs`, and an image does
 * not fit in text: a pasted screenshot is megabytes of base64 the daemon deliberately never parses
 * (`packages/daemon/src/lib/transcript/large-strings.ts`). So the log carries a MARKER where an image
 * was, and the marker names a HANDLE the daemon resolves back to the image's bytes on request.
 *
 * A HANDLE NAMES A RECORD, NEVER A BYTE RANGE. It is the byte offset and length of the one transcript
 * record the image is in, plus which image of that record it is. The daemon re-reads that record,
 * proves it IS a whole record its parser emitted, and takes the image's bytes from what the parser
 * found there — so a caller can never point the route at arbitrary bytes of the file, only at an image
 * the session actually holds. The ordinal counts images in the order {@link TranscriptImageHandle}'s
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
import { z } from 'zod';

/** The image types a chat paints. Anything else in a transcript stays a text label. */
export const TRANSCRIPT_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
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
export const transcriptImagePath = (sessionId: string, handle: TranscriptImageHandle): string =>
  `/v1/sessions/${encodeURIComponent(sessionId)}/transcript-images/${formatTranscriptImageHandle(handle)}`;

/**
 * The answer: the image's bytes as standard (padded, `+/`) base64, and the type the daemon read from
 * the bytes themselves — never the transcript's claim, which a model wrote.
 */
export const TranscriptImageDownloadSchema = z.strictObject({
  image: z.strictObject({
    handle: z.string().regex(HANDLE),
    mediaType: z.enum(TRANSCRIPT_IMAGE_MEDIA_TYPES),
    byteLength: z.number().int().positive(),
  }),
  // No pattern check: a regex over megabytes of base64 would stall the reader for nothing, and a bad
  // character fails the decode that has to read every byte anyway.
  base64: z.string().min(4),
});
export type TranscriptImageDownload = z.infer<typeof TranscriptImageDownloadSchema>;
