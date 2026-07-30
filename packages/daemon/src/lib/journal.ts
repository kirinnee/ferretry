import { z } from 'zod';
import { InstantSchema } from './instant.ts';
import { canonicalJsonValue, type JsonValue, JsonValueSchema } from './json.ts';
import { type SessionId, SessionIdSchema } from './session-id.ts';
import type { EventPointer, JournalProblem, SessionEvent } from './storage-types.ts';

/**
 * Maximum encoded size of a single journal record: one JSONL line excluding its trailing newline.
 *
 * The scanner stream-discards any record that exceeds this bound, so a single huge or torn
 * (newline-free) line can neither retain unbounded pending memory nor force quadratic recopying
 * across chunks. The encoder enforces the same bound so `append` can never write a record that a
 * later rebuild would reject. Override per-call with the `maxRecordBytes` scan option in tests.
 */
export const MAX_JOURNAL_RECORD_BYTES = 1 << 20; // 1 MiB

export class JournalRecordTooLargeError extends Error {
  constructor(
    readonly byteLength: number,
    readonly maxBytes: number,
  ) {
    super(`journal record of ${byteLength} bytes exceeds the maximum of ${maxBytes} bytes`);
    this.name = 'JournalRecordTooLargeError';
  }
}

/** Throw when an encoded journal record exceeds the byte cap. Defaults to the production cap. */
export function assertJournalRecordSize(encoded: string, maxBytes: number = MAX_JOURNAL_RECORD_BYTES): void {
  const byteLength = Buffer.byteLength(encoded, 'utf8');
  if (byteLength > maxBytes) throw new JournalRecordTooLargeError(byteLength, maxBytes);
}

export const SessionEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sequence: z.number().int().safe().positive(),
  sessionId: SessionIdSchema,
  time: InstantSchema,
  type: z
    .string()
    .min(1)
    .refine(value => value.trim() === value, 'event type must not have surrounding whitespace'),
  data: JsonValueSchema,
});

export interface JournalScanOptions {
  readonly file: string;
  readonly sessionId: SessionId;
  readonly baseOffset?: number;
  readonly firstLine?: number;
  readonly previousSequence?: number;
  readonly maxRecordBytes?: number;
}

export interface JournalScan {
  readonly events: readonly SessionEvent[];
  readonly pointers: readonly EventPointer[];
  readonly problems: readonly JournalProblem[];
  readonly scannedTo: number;
  readonly lastSequence: number;
  /**
   * The 1-based line number of the record that contains the byte at `scannedTo`. When the scan
   * ends immediately after a line feed this is the next line; at EOF without a trailing line feed
   * it stays on the final record's line. Persisted so tail reconciliation can resume by line.
   */
  readonly lineAtOffset: number;
}

export interface JournalScanCursor {
  readonly pending: Uint8Array;
  readonly byteOffset: number;
  readonly line: number;
  readonly lastSequence: number;
  /**
   * Streaming-discard state: a previous chunk found a record that exceeds the cap before it
   * reached a newline. While set, incoming bytes are dropped through the next newline without
   * being retained, then normal parsing resumes. The oversized record is reported exactly once.
   */
  readonly discarding?: boolean;
}

export interface JournalChunkScan {
  readonly cursor: JournalScanCursor;
  readonly scan: JournalScan;
}

export function createJournalScanCursor(
  options: Pick<JournalScanOptions, 'baseOffset' | 'firstLine' | 'previousSequence'> = {},
): JournalScanCursor {
  return {
    pending: new Uint8Array(),
    byteOffset: options.baseOffset ?? 0,
    line: options.firstLine ?? 1,
    lastSequence: options.previousSequence ?? 0,
  };
}

type JournalChunkOptions = Pick<JournalScanOptions, 'file' | 'sessionId'> & { readonly final?: boolean };

export function scanJournalChunk(
  cursor: JournalScanCursor,
  bytes: Uint8Array,
  options: JournalChunkOptions & { readonly maxRecordBytes?: number },
): JournalChunkScan {
  const cap = options.maxRecordBytes ?? MAX_JOURNAL_RECORD_BYTES;
  if (cursor.discarding) return discardOversizedRecord(cursor, bytes, options, cap);
  return scanJournalChunkRun(cursor, bytes, options, cap);
}

function scanJournalChunkRun(
  cursor: JournalScanCursor,
  bytes: Uint8Array,
  options: JournalChunkOptions,
  cap: number,
): JournalChunkScan {
  const combined = new Uint8Array(cursor.pending.byteLength + bytes.byteLength);
  combined.set(cursor.pending);
  combined.set(bytes, cursor.pending.byteLength);

  let processedLength = combined.byteLength;
  if (!options.final) {
    processedLength = 0;
    for (let index = combined.byteLength - 1; index >= 0; index -= 1) {
      if (combined[index] !== 0x0a) continue;
      processedLength = index + 1;
      break;
    }
  }
  const processed = combined.subarray(0, processedLength);
  const scan = scanJournal(processed, {
    file: options.file,
    sessionId: options.sessionId,
    baseOffset: cursor.byteOffset,
    firstLine: cursor.line,
    previousSequence: cursor.lastSequence,
    maxRecordBytes: cap,
  });

  const completedLines = countNewlines(processed);
  const trailing = combined.subarray(processedLength);
  const nextLine = cursor.line + completedLines;
  const nextOffset = scan.scannedTo;

  // A non-final trailing partial has no newline yet and can only grow. If it already exceeds the
  // cap the record can never be valid, so report it once at its true origin, retain nothing, and
  // stream-discard the remainder through the next newline.
  if (!options.final && trailing.byteLength > cap) {
    const consumedTo = nextOffset + trailing.byteLength;
    return {
      cursor: {
        pending: new Uint8Array(),
        byteOffset: consumedTo,
        line: nextLine,
        lastSequence: scan.lastSequence,
        discarding: true,
      },
      scan: {
        events: scan.events,
        pointers: scan.pointers,
        problems: [
          ...scan.problems,
          { file: options.file, line: nextLine, byteOffset: nextOffset, message: oversizedRecordMessage(cap) },
        ],
        scannedTo: consumedTo,
        lastSequence: scan.lastSequence,
        lineAtOffset: nextLine,
      },
    };
  }

  return {
    cursor: {
      pending: trailing.slice(),
      byteOffset: nextOffset,
      line: nextLine,
      lastSequence: scan.lastSequence,
      discarding: false,
    },
    scan,
  };
}

function discardOversizedRecord(
  cursor: JournalScanCursor,
  bytes: Uint8Array,
  options: JournalChunkOptions,
  cap: number,
): JournalChunkScan {
  const newlineIndex = bytes.indexOf(0x0a);
  if (newlineIndex === -1) {
    // Still inside the oversized record: drop the whole chunk and keep the discard state. The
    // problem was already emitted when the record first exceeded the cap, so nothing is added here.
    const consumedTo = cursor.byteOffset + bytes.byteLength;
    return {
      cursor: {
        pending: new Uint8Array(),
        byteOffset: consumedTo,
        line: cursor.line,
        lastSequence: cursor.lastSequence,
        discarding: true,
      },
      scan: {
        events: [],
        pointers: [],
        problems: [],
        scannedTo: consumedTo,
        lastSequence: cursor.lastSequence,
        lineAtOffset: cursor.line,
      },
    };
  }
  // The oversized record terminates; resume normal parsing after its newline with corrected
  // absolute offset, line number, and previous-sequence context.
  return scanJournalChunkRun(
    {
      pending: new Uint8Array(),
      byteOffset: cursor.byteOffset + newlineIndex + 1,
      line: cursor.line + 1,
      lastSequence: cursor.lastSequence,
      discarding: false,
    },
    bytes.subarray(newlineIndex + 1),
    options,
    cap,
  );
}

export function createSessionEvent(
  sessionId: SessionId,
  previousSequence: number,
  time: string,
  type: string,
  data: unknown,
): SessionEvent {
  return SessionEventSchema.parse({
    schemaVersion: 1,
    sequence: previousSequence + 1,
    sessionId,
    time,
    type,
    data: canonicalJsonValue(data),
  });
}

export function parseSessionEvent(value: unknown, expectedSessionId: SessionId): SessionEvent | undefined {
  const parsed = SessionEventSchema.safeParse(value);
  return parsed.success && parsed.data.sessionId === expectedSessionId ? parsed.data : undefined;
}

function decodeLine(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function oversizedRecordMessage(cap: number): string {
  return `event record exceeds the maximum encoded size of ${cap} bytes`;
}

function countNewlines(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  return count;
}

export function scanJournal(bytes: Uint8Array, options: JournalScanOptions): JournalScan {
  const events: SessionEvent[] = [];
  const pointers: EventPointer[] = [];
  const problems: JournalProblem[] = [];
  const baseOffset = options.baseOffset ?? 0;
  const cap = options.maxRecordBytes ?? MAX_JOURNAL_RECORD_BYTES;
  let line = options.firstLine ?? 1;
  let lineStart = 0;
  let lastSequence = options.previousSequence ?? 0;

  const inspect = (lineEnd: number): void => {
    const raw = bytes.subarray(lineStart, lineEnd);
    const byteOffset = baseOffset + lineStart;
    if (raw.byteLength > cap) {
      problems.push({ file: options.file, line, byteOffset, message: oversizedRecordMessage(cap) });
      return;
    }
    const text = decodeLine(raw);
    if (text === undefined) {
      problems.push({ file: options.file, line, byteOffset, message: 'event record is not valid UTF-8' });
      return;
    }
    if (text.trim().length === 0) return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      problems.push({ file: options.file, line, byteOffset, message: 'invalid JSON event record' });
      return;
    }
    const event = parseSessionEvent(decoded, options.sessionId);
    if (event === undefined) {
      problems.push({ file: options.file, line, byteOffset, message: 'invalid event schema or session id' });
      return;
    }
    if (event.sequence <= lastSequence) {
      problems.push({
        file: options.file,
        line,
        byteOffset,
        message: `event sequence ${event.sequence} is not greater than ${lastSequence}`,
      });
      return;
    }
    events.push(event);
    pointers.push({
      sessionId: options.sessionId,
      sequence: event.sequence,
      time: event.time,
      type: event.type,
      byteOffset,
      byteLength: raw.byteLength,
    });
    lastSequence = event.sequence;
  };

  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    inspect(index);
    lineStart = index + 1;
    line += 1;
  }
  if (lineStart < bytes.byteLength) inspect(bytes.byteLength);

  return {
    events,
    pointers,
    problems,
    scannedTo: baseOffset + bytes.byteLength,
    lastSequence,
    lineAtOffset: line,
  };
}

export function encodeSessionEvent(event: SessionEvent<JsonValue>): string {
  const encoded = JSON.stringify(SessionEventSchema.parse(event));
  assertJournalRecordSize(encoded);
  return encoded;
}
