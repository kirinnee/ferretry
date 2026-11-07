import type {
  TranscriptInputObserver,
  TranscriptParseInput,
  TranscriptParser,
  TranscriptParseResult,
  TranscriptRawRecord,
} from './types.ts';
import { utf8Length } from './utf8.ts';

/**
 * How many bytes of transcript are parsed between two looks at the clock, and how long a parse may hold
 * the event loop before it yields.
 *
 * A bounded read is still up to 32 MiB, and parsing it in one synchronous call held a daemon's event
 * loop for seconds — on a Mac with three 200 MB transcripts, long enough that nothing answered at all.
 * The parse is cut at record boundaries and hands the loop back whenever a slice has run past the
 * budget, so a large read costs time, never responsiveness.
 */
export const PARSE_SLICE_BYTES = 256 * 1024;
const PARSE_BUDGET_MS = 12;

/**
 * The clock and the yield a sliced parse paces itself with.
 *
 * Injected, so the domain decides WHEN the loop is handed back while the runtime that hands it back
 * stays in the composition root — and a test can count the yields instead of racing a timer.
 */
export interface TranscriptParsePacing {
  /** A monotonic reading in milliseconds. */
  now(): number;
  /** Lets every timer and socket waiting on the loop run before the parse continues. */
  yieldToLoop(): Promise<void>;
}

/**
 * What a sliced parse reads: decoded text, or the bytes of a read — one buffer, or several pieces of one.
 *
 * Pieces exist so a follower never has to join a whole read into one buffer just to parse it: the
 * record it carried over from the last read is joined to the start of the new one, and the rest of the
 * new read is parsed where it already lies. EVERY PIECE BUT THE LAST MUST END ON A RECORD TERMINATOR;
 * the parse continues across pieces exactly as it continues across slices.
 */
export type SlicedTranscriptInput = Omit<TranscriptParseInput, 'text' | 'bytes'> &
  (
    | { readonly text: string; readonly bytes?: undefined }
    | { readonly text?: undefined; readonly bytes: Uint8Array | readonly Uint8Array[] }
  );

const LINE_FEED = 0x0a;

/** One contiguous run of input, cut and measured the same way whichever form it arrived in. */
interface InputPiece {
  readonly length: number;
  /** Where a slice of at most `limit` units starting at `from` ends: just past a newline, or at the end. */
  end(from: number, limit: number): number;
  /** The parse input for `[from, to)`: the bytes themselves, or the text. */
  input(from: number, to: number): { readonly text: string } | { readonly bytes: Uint8Array };
  /** How many record terminators `[from, to)` holds. */
  lines(from: number, to: number): number;
  /** How many file bytes `[from, to)` occupies. */
  bytes(from: number, to: number): number;
}

/**
 * Where a slice ends, given the last and next terminator positions a piece can find.
 *
 * One record longer than a slice is parsed whole, up to its own terminator: JSON cannot be parsed in
 * halves, so a record's own size is the one cost a slice cannot cut.
 */
function cut(
  length: number,
  from: number,
  limit: number,
  lastBefore: (at: number) => number,
  nextFrom: (at: number) => number,
): number {
  if (length - from <= limit) return length;
  const newline = lastBefore(from + limit - 1);
  if (newline >= from) return newline + 1;
  const next = nextFrom(from + limit);
  return next < 0 ? length : next + 1;
}

/**
 * How many record terminators `bytes` holds.
 *
 * By `indexOf`, which the runtime answers with a native scan, rather than by iterating the bytes: the
 * iterator cost about 30 ms a megabyte, and a bounded read counts up to 32 MiB of them, so counting
 * lines alone held the event loop longer than parsing the records did.
 */
export function countLines(bytes: Uint8Array): number {
  let lines = 0;
  for (let at = bytes.indexOf(LINE_FEED); at >= 0; at = bytes.indexOf(LINE_FEED, at + 1)) lines += 1;
  return lines;
}

function bytePiece(bytes: Uint8Array): InputPiece {
  return {
    length: bytes.byteLength,
    end: (from, limit) =>
      cut(
        bytes.byteLength,
        from,
        limit,
        at => bytes.lastIndexOf(LINE_FEED, at),
        at => bytes.indexOf(LINE_FEED, at),
      ),
    input: (from, to) => ({ bytes: bytes.subarray(from, to) }),
    lines: (from, to) => countLines(bytes.subarray(from, to)),
    bytes: (from, to) => to - from,
  };
}

function textPiece(text: string): InputPiece {
  return {
    length: text.length,
    end: (from, limit) =>
      cut(
        text.length,
        from,
        limit,
        at => text.lastIndexOf('\n', at),
        at => text.indexOf('\n', at),
      ),
    input: (from, to) => ({ text: text.slice(from, to) }),
    lines: (from, to) => {
      let lines = 0;
      for (let at = text.indexOf('\n', from); at >= 0 && at < to; at = text.indexOf('\n', at + 1)) lines += 1;
      return lines;
    },
    bytes: (from, to) => utf8Length(text, from, to),
  };
}

/** The input as pieces to slice; an empty piece is dropped unless it is all there is, which still parses once. */
function piecesOf(input: SlicedTranscriptInput): readonly InputPiece[] {
  if (input.bytes === undefined) return [textPiece(input.text)];
  if (input.bytes instanceof Uint8Array) return [bytePiece(input.bytes)];
  const pieces = input.bytes.filter(bytes => bytes.byteLength > 0);
  return (pieces.length > 0 ? pieces : [new Uint8Array()]).map(bytePiece);
}

/**
 * The same parse as one `parser.parse` over the whole input, cut into record-aligned slices with the
 * event loop handed back between them once a slice runs past {@link PARSE_BUDGET_MS}.
 *
 * Every slice but the last ends on a record terminator, so none leaves a remainder, and one observer
 * carries the parser's cross-record state through all of them exactly as one call would. Line numbers
 * and byte offsets continue from slice to slice, so what is reported is what one whole parse reports.
 *
 * Bytes are handed to the parser as bytes and never decoded here: the parser decodes each bounded
 * record itself, so a whole-read decode would be a second copy of every byte that nothing reads.
 */
export async function parseTranscriptInSlices(
  parser: TranscriptParser,
  input: SlicedTranscriptInput,
  pacing: TranscriptParsePacing,
  observer: TranscriptInputObserver = parser.createInputObserver(),
): Promise<TranscriptParseResult> {
  const { text: _text, bytes: _bytes, ...common } = input;
  const pieces = piecesOf(input);
  const events: TranscriptParseResult['events'][number][] = [];
  const observedInputs: TranscriptParseResult['observedInputs'][number][] = [];
  const issues: TranscriptParseResult['issues'][number][] = [];
  let rawRecords: TranscriptRawRecord[] | undefined;
  let parsedRecords = 0;
  let ignoredRecords = 0;
  let remainder = '';
  let line = input.startLine ?? 1;
  let byteOffset = input.startByteOffset ?? 0;
  let sliceStartedAt = pacing.now();
  let started = false;
  for (const [index, piece] of pieces.entries()) {
    for (let from = 0, done = false; !done; ) {
      if (started && pacing.now() - sliceStartedAt >= PARSE_BUDGET_MS) {
        await pacing.yieldToLoop();
        sliceStartedAt = pacing.now();
      }
      started = true;
      const to = piece.end(from, PARSE_SLICE_BYTES);
      done = to >= piece.length;
      const parsed = parser.parse(
        {
          ...common,
          ...piece.input(from, to),
          endOfInput: done && index === pieces.length - 1 ? input.endOfInput : false,
          startLine: line,
          startByteOffset: byteOffset,
        },
        observer,
      );
      for (const event of parsed.events) events.push(event);
      for (const observed of parsed.observedInputs) observedInputs.push(observed);
      for (const issue of parsed.issues) issues.push(issue);
      if (parsed.rawRecords !== undefined) {
        rawRecords ??= [];
        for (const record of parsed.rawRecords) rawRecords.push(record);
      }
      parsedRecords += parsed.parsedRecords;
      ignoredRecords += parsed.ignoredRecords;
      remainder = parsed.remainder;
      line += piece.lines(from, to);
      byteOffset += piece.bytes(from, to);
      from = to;
    }
  }
  return {
    harness: parser.harness,
    events,
    observedInputs,
    issues,
    remainder,
    parsedRecords,
    ignoredRecords,
    ...(rawRecords === undefined ? {} : { rawRecords }),
  };
}

/**
 * A parser whose every parse goes through {@link parseTranscriptInSlices}.
 *
 * For a reader that holds a whole transcript as text — a history listing reads every file up to
 * 32 MiB whole — and so would otherwise parse it in one synchronous call on the daemon's loop.
 */
export class PacedTranscriptParser {
  readonly harness: TranscriptParser['harness'];

  constructor(
    private readonly parser: TranscriptParser,
    private readonly pacing: TranscriptParsePacing,
  ) {
    this.harness = parser.harness;
  }

  async parse(input: SlicedTranscriptInput, observer?: TranscriptInputObserver): Promise<TranscriptParseResult> {
    return await parseTranscriptInSlices(this.parser, input, this.pacing, observer);
  }
}
