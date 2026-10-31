import type { TranscriptRecordRange, TranscriptRecordScanner } from '../../lib/session/transcript/log-search.ts';
import { NodeTranscriptFileRuntime, type TranscriptFileRuntime } from './file-source.ts';

/** The bytes one backward step reads, before it widens for a record longer than that. */
const SCAN_CHUNK_BYTES = 8 * 1024 * 1024;

/** The longest record a scan steps over whole; past it the record is skipped, as the source drops it. */
const MAX_RECORD_BYTES = 64 * 1024 * 1024;

const NEWLINE = 0x0a;

/**
 * `bytes` as one character per byte, lower-cased, so a lower-cased ASCII needle finds any spelling of
 * itself at the very index of its bytes. Latin-1 lower-casing never changes a string's length, and the
 * only characters it changes that a UTF-8 file can hold as ASCII are the capitals; the rest are bytes of
 * multi-byte characters, which an ASCII needle never matches. The engine's own lower-casing is about two
 * and a half times quicker than folding the bytes one by one (measured over a 428 MB transcript).
 */
const asciiLower = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1').toLowerCase();

/**
 * The transcript's records, newest first, read BACKWARDS from the end a chunk at a time — and, given a
 * needle, only the records whose raw bytes hold it.
 *
 * A search reads a whole conversation, and parsing every record of a 400 MB one is seconds of work for
 * a question most of whose answer is in the last few megabytes. The raw bytes of a JSONL record already
 * say whether it can match: the needle is printable ASCII with no quote or backslash (see
 * `prefilterNeedle`), which a JSON writer leaves as it is, so a record whose bytes lack it cannot hold
 * it in any string. Only the records that do are parsed, and newest first, so a search that has found
 * enough stops without reading the rest of the file.
 */
export class NodeTranscriptRecordScanner implements TranscriptRecordScanner {
  constructor(
    private readonly runtime: TranscriptFileRuntime = new NodeTranscriptFileRuntime(),
    private readonly chunk: number = SCAN_CHUNK_BYTES,
    private readonly maxRecord: number = MAX_RECORD_BYTES,
  ) {}

  async *records(file: string, needle: string | undefined): AsyncGenerator<TranscriptRecordRange> {
    const info = await this.runtime.info(file);
    if (info === undefined) return;
    const pattern = needle === undefined || needle === '' ? undefined : needle.toLowerCase();
    let end = info.size;
    let width = this.chunk;
    while (end > 0) {
      const begin = Math.max(0, end - width);
      const bytes = await this.runtime.readRange(file, begin, end - begin);
      // The first line of a chunk that does not begin the file may have begun before it: it is read
      // with the next chunk back, from its own first byte. A chunk whose only newline ends it holds no
      // whole record at all — one record is longer than the chunk — so the chunk widens instead.
      const feed = begin === 0 ? -1 : bytes.indexOf(NEWLINE);
      if (begin > 0 && (feed < 0 || feed === bytes.length - 1)) {
        if (width >= this.maxRecord) {
          end = begin;
          width = this.chunk;
        } else width *= 2;
        continue;
      }
      width = this.chunk;
      const first = feed + 1;
      const segment = bytes.subarray(first);
      const origin = begin + first;
      yield* pattern === undefined ? everyRecord(segment, origin) : recordsHolding(segment, origin, pattern);
      end = origin;
    }
  }
}

/** Every record of `segment` (which begins on a record boundary at `origin`), newest first. */
function* everyRecord(segment: Uint8Array, origin: number): Generator<TranscriptRecordRange> {
  let stop = segment.length;
  while (stop > 0) {
    const previous = stop - 2 < 0 ? -1 : segment.lastIndexOf(NEWLINE, stop - 2);
    yield { start: origin + previous + 1, end: origin + stop };
    stop = previous + 1;
  }
}

/** The records of `segment` whose bytes, case folded, hold `pattern`, newest first. */
function* recordsHolding(segment: Uint8Array, origin: number, pattern: string): Generator<TranscriptRecordRange> {
  const folded = asciiLower(segment);
  let from = folded.length;
  while (from > 0) {
    const at = folded.lastIndexOf(pattern, from - 1);
    if (at < 0) return;
    const start = at === 0 ? 0 : folded.lastIndexOf('\n', at - 1) + 1;
    const newline = folded.indexOf('\n', at);
    yield { start: origin + start, end: origin + (newline < 0 ? folded.length : newline + 1) };
    from = start;
  }
}
