/**
 * A session's event journal: the contract's `FerretHistoryFiles` (`<session>/history.jsonl`), one event per line.
 *
 * Today's `lib/journal.ts`, moved onto the state port. The event shape, its schema and its sequence rule are
 * unchanged; what changed is how a journal is READ. The state port hands back a JSONL file line by line, already
 * parsed, and has no byte offset, so every position this module reports — a pointer's `byteOffset`, a scan's
 * `scannedTo`, a fingerprint's `size` — is counted in LINES: the zero-based index of an event's line, and the number
 * of lines read. `byteLength` is always 1 (one line). The index, the rebuild plan and the reconciliation plan keep
 * their shapes, and "the journal grew" still means "it has more lines than the index has seen".
 */
import { canonicalJsonValue, type JsonValue } from '@ferretry/std';
import { FerretHistoryEventSchema } from '../../../contract/state.ts';
import type { SessionId } from '../session-id.ts';
import type { EventPointer, JournalFingerprint, JournalProblem, SessionEvent } from '../storage-types.ts';

/**
 * Maximum encoded size of a single journal record: one JSONL line excluding its trailing newline.
 *
 * The encoder enforces the bound so `append` can never write a record that a later rebuild would reject.
 */
const MAX_JOURNAL_RECORD_BYTES = 1 << 20; // 1 MiB

class JournalRecordTooLargeError extends Error {
  constructor(
    readonly byteLength: number,
    readonly maxBytes: number,
  ) {
    super(`journal record of ${byteLength} bytes exceeds the maximum of ${maxBytes} bytes`);
    this.name = 'JournalRecordTooLargeError';
  }
}

/** Throw when an encoded journal record exceeds the byte cap. Defaults to the production cap. */
function assertJournalRecordSize(encoded: string, maxBytes: number = MAX_JOURNAL_RECORD_BYTES): void {
  const byteLength = new TextEncoder().encode(encoded).byteLength;
  if (byteLength > maxBytes) throw new JournalRecordTooLargeError(byteLength, maxBytes);
}

/** Today's stored event record; the contract owns it as `FerretHistoryFiles`' schema. */
const SessionEventSchema = FerretHistoryEventSchema;

/** One line of a journal as the state port gave it: the parsed entry, or why that line could not be read. */
export type JournalLine = { readonly value: unknown } | { readonly damaged: string };

export interface JournalScanOptions {
  readonly file: string;
  readonly sessionId: SessionId;
  /** How many lines precede `lines` in the journal: the position of its first line. */
  readonly baseOffset?: number;
  readonly firstLine?: number;
  readonly previousSequence?: number;
}

export interface JournalScan {
  readonly events: readonly SessionEvent[];
  readonly pointers: readonly EventPointer[];
  readonly problems: readonly JournalProblem[];
  /** Lines read, counting the `baseOffset` before them. */
  readonly scannedTo: number;
  readonly lastSequence: number;
  /** The 1-based line number after the last line read. Persisted so tail reconciliation can resume by line. */
  readonly lineAtOffset: number;
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

/** The entry `append` writes: the event, checked against its schema and the record cap. */
export function encodeSessionEvent(event: SessionEvent<JsonValue>): SessionEvent {
  const parsed = SessionEventSchema.parse(event);
  assertJournalRecordSize(JSON.stringify(parsed));
  return parsed;
}

/**
 * What stands in for a journal file's identity: nothing for a journal with no lines (the state port cannot tell an
 * empty journal from an absent one), else its length in lines. There is one journal per session and the state port
 * never replaces it, so the identity fields are constant.
 */
export function journalFingerprint(lines: number): JournalFingerprint | null {
  return lines === 0 ? null : { device: 'state', inode: 'history', size: lines, modifiedAtMs: 0 };
}

/**
 * Today's `scanJournal` as it takes lines: one at a time, in file order, so a journal of any size costs its pointers
 * and not its lines. Every damaged or out-of-order line is a problem, never fatal. `keepEvents` also keeps each parsed
 * event (the array form below wants them; the index only ever needs the pointers).
 */
export class JournalScanner {
  readonly #options: JournalScanOptions;
  readonly #keepEvents: boolean;
  readonly #events: SessionEvent[] = [];
  readonly #pointers: EventPointer[] = [];
  readonly #problems: JournalProblem[] = [];
  readonly #baseOffset: number;
  #count = 0;
  #line: number;
  #lastSequence: number;

  constructor(options: JournalScanOptions, keepEvents = false) {
    this.#options = options;
    this.#keepEvents = keepEvents;
    this.#baseOffset = options.baseOffset ?? 0;
    this.#line = options.firstLine ?? 1;
    this.#lastSequence = options.previousSequence ?? 0;
  }

  /** How many lines were taken: what the journal's fingerprint counts. */
  get count(): number {
    return this.#count;
  }

  push(entry: JournalLine): void {
    const options = this.#options;
    const byteOffset = this.#baseOffset + this.#count;
    this.#count += 1;
    const at = this.#line;
    this.#line += 1;
    if ('damaged' in entry) {
      this.#problems.push({ file: options.file, line: at, byteOffset, message: entry.damaged });
      return;
    }
    const event = parseSessionEvent(entry.value, options.sessionId);
    if (event === undefined) {
      this.#problems.push({ file: options.file, line: at, byteOffset, message: 'invalid event schema or session id' });
      return;
    }
    if (event.sequence <= this.#lastSequence) {
      this.#problems.push({
        file: options.file,
        line: at,
        byteOffset,
        message: `event sequence ${event.sequence} is not greater than ${this.#lastSequence}`,
      });
      return;
    }
    if (this.#keepEvents) this.#events.push(event);
    this.#pointers.push({
      sessionId: options.sessionId,
      sequence: event.sequence,
      time: event.time,
      type: event.type,
      byteOffset,
      byteLength: 1,
    });
    this.#lastSequence = event.sequence;
  }

  scan(): JournalScan {
    return {
      events: this.#events,
      pointers: this.#pointers,
      problems: this.#problems,
      scannedTo: this.#baseOffset + this.#count,
      lastSequence: this.#lastSequence,
      lineAtOffset: this.#line,
    };
  }
}

/** {@link JournalScanner} over lines already in hand. */
export function scanJournal(lines: readonly JournalLine[], options: JournalScanOptions): JournalScan {
  const scanner = new JournalScanner(options, true);
  for (const entry of lines) scanner.push(entry);
  return scanner.scan();
}
