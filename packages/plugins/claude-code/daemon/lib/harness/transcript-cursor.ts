import type { HarnessTailRecord } from '@ferretry/core-ferrets/contract';
import { markCutWindow, parseTail } from './transcript.ts';

/**
 * An INCREMENTAL READ OF A TRANSCRIPT'S TAIL. The turn watch asks for the newest records of every busy ferret's transcript
 * every couple of seconds; a transcript that grows every second used to be re-read and re-parsed whole (up to the
 * window) each time. A cursor keeps what was already parsed, so a growth costs the NEW bytes only, and the answer is
 * exactly what one parse of the window would have said ({@link windowRecords}): the same lines are read, in the same
 * order, by the same parser.
 *
 * What makes it equal to a full parse:
 *  - a record never spans lines, and the parser keeps no state between lines, so the records of a window are the
 *    records of its lines in order;
 *  - the window is the last `windowBytes` of the file; when it does not start the file its first line is the one that
 *    STARTS at the window's first byte (a line cut by the window, or one that happens to begin there), and is dropped,
 *    so a committed line leaves the window once it starts at or before the window's first byte;
 *  - an unfinished last line (no newline yet) is parsed (it is a record when it is complete JSON) but never committed:
 *    it is read again with the bytes that follow it.
 *
 * Pure: no disk, no clock. The reader owns what to read and when to start over ({@link canAdvance}).
 */

/** One whole line (up to and including its newline), the byte offset it starts at, and what it parsed to. */
interface CommittedLine {
  readonly start: number;
  readonly records: readonly HarnessTailRecord[];
}

/** What a reader keeps per transcript between two looks. */
export interface TailCursor {
  /** Which file it was read from: its identity (device and inode), so a replaced file starts over. */
  readonly identity: string;
  /** The window size this cursor was read with. */
  readonly windowBytes: number;
  /** The file's size at the last read. */
  readonly size: number;
  /** The offset just after the last newline taken: the next read starts here (a committed line ends before it). */
  readonly consumed: number;
  /** The window's first byte (`0` when the window starts the file). */
  readonly from: number;
  /** Whole lines still inside the window, oldest first. */
  readonly lines: readonly CommittedLine[];
  /** The unfinished last line's record (if it is already complete JSON) and where the line starts. */
  readonly open: { readonly start: number; readonly records: readonly HarnessTailRecord[] } | undefined;
}

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

/** The lines of `bytes` (that begin at file offset `at`): whole ones, and the open one after the last newline. */
function split(
  bytes: Uint8Array,
  at: number,
): { readonly whole: readonly CommittedLine[]; readonly consumed: number; readonly open: TailCursor['open'] } {
  const whole: CommittedLine[] = [];
  let begin = 0;
  for (let end = bytes.indexOf(NEWLINE); end >= 0; end = bytes.indexOf(NEWLINE, begin)) {
    // Parsed as one whole line: the parser's own partial flag is for a window cut mid-record, which a line never is.
    whole.push({ start: at + begin, records: parseTail(decoder.decode(bytes.subarray(begin, end)), false) });
    begin = end + 1;
  }
  const rest = bytes.subarray(begin);
  return {
    whole,
    consumed: at + begin,
    open: rest.byteLength === 0 ? undefined : { start: at + begin, records: parseTail(decoder.decode(rest), false) },
  };
}

/** The lines that are still in a window starting at `from`: with the window cut (`from > 0`) the line starting AT it is cut. */
const inWindow = (line: { readonly start: number }, from: number): boolean => from === 0 || line.start > from;

/** The window's first byte for a file of `size`. */
const windowFrom = (size: number, windowBytes: number): number => Math.max(0, size - windowBytes);

/**
 * A cursor from one read of the window: the last `bytes` of a file of `size` bytes (`size > bytes.length` says the
 * window is cut) of the file with `identity`.
 */
export function openCursor(identity: string, bytes: Uint8Array, size: number, windowBytes: number): TailCursor {
  const at = Math.max(0, size - bytes.byteLength);
  const read = split(bytes, at);
  // Where the window starts is where these bytes start: what `readTail` actually returned, not what was asked.
  const from = at;
  return {
    identity,
    windowBytes,
    size,
    consumed: read.consumed,
    from,
    lines: read.whole.filter(line => inWindow(line, from)),
    open: read.open !== undefined && inWindow(read.open, from) ? read.open : undefined,
  };
}

/**
 * Whether a file with `identity` and `size` can be followed from `cursor` by reading only what was appended: the same
 * file, no smaller, and not grown past what the window holds (a bigger growth is one full read, which is no dearer).
 */
export function canAdvance(cursor: TailCursor, identity: string, size: number): boolean {
  return cursor.identity === identity && size >= cursor.size && size - cursor.consumed <= cursor.windowBytes;
}

/** Where an advance reads from: one byte BEFORE the unconsumed part, which must be the newline that ended the last line. */
export const advanceFrom = (cursor: TailCursor): number => Math.max(0, cursor.consumed - 1);

/**
 * The cursor after the file grew to `size`, given the bytes read from {@link advanceFrom}. `undefined` when they cannot be
 * trusted to continue this cursor (the byte before the new part is not a newline: the file was rewritten, not
 * appended to; or fewer bytes came than the growth): the reader then starts over with a full read.
 */
export function advanceCursor(cursor: TailCursor, bytes: Uint8Array, size: number): TailCursor | undefined {
  const lead = cursor.consumed > 0 ? 1 : 0;
  if (cursor.consumed > 0 && bytes[0] !== NEWLINE) return undefined;
  if (bytes.byteLength < size - advanceFrom(cursor)) return undefined;
  const fresh = bytes.subarray(lead);
  const read = split(fresh, cursor.consumed);
  const from = windowFrom(size, cursor.windowBytes);
  return {
    ...cursor,
    size,
    consumed: read.consumed,
    from,
    lines: [...cursor.lines, ...read.whole].filter(line => inWindow(line, from)),
    open: read.open !== undefined && inWindow(read.open, from) ? read.open : undefined,
  };
}

/**
 * The records the cursor holds, with the cut-window rule applied: what `markCutWindow(parseTail(window, cut), cut)` says,
 * newest `limit` of them.
 */
export function windowRecords(cursor: TailCursor, limit: number): readonly HarnessTailRecord[] {
  const cut = cursor.from > 0;
  const records = cursor.lines.flatMap(line => line.records);
  if (cursor.open !== undefined) records.push(...cursor.open.records);
  return markCutWindow(records, cut).slice(-limit);
}
