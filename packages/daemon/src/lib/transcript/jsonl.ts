import type {
  TranscriptIssue,
  TranscriptInputObserver,
  TranscriptParseInput,
  TranscriptParseResult,
  TranscriptParser,
  TranscriptRawRecord,
  TranscriptRecordResult,
} from './types.ts';

type TranscriptRecordParser = Pick<TranscriptParser, 'harness' | 'parseRecord'>;

interface NormalizedTranscriptRecord extends TranscriptRecordResult {
  readonly observedInputs: TranscriptParseResult['observedInputs'];
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const BYTE_ORDER_MARK = '\uFEFF';

/** A BOM is legal UTF-8 but illegal JSON whitespace, so leaving one in place would lose the first
 *  record of any transcript an editor rewrote. */
function stripByteOrderMark(value: string): string {
  let text = value;
  while (text.startsWith(BYTE_ORDER_MARK)) text = text.slice(BYTE_ORDER_MARK.length);
  return text;
}

function malformedLineIssue(
  parser: TranscriptRecordParser,
  input: TranscriptParseInput,
  code: 'invalid-json' | 'incomplete-line' | 'truncated-json' | 'invalid-record',
  line: number,
  byteOffset: number,
  byteLength: number,
): TranscriptIssue {
  const messages = {
    'invalid-json': 'complete transcript line is not valid JSON',
    'incomplete-line': 'trailing transcript line is incomplete',
    'truncated-json': 'final transcript line contains truncated JSON',
    'invalid-record': 'transcript record could not be normalized',
  } as const;
  return {
    harness: parser.harness,
    code,
    message: messages[code],
    recoverable: code !== 'invalid-json',
    source: input.source,
    line,
    byteOffset,
    byteLength,
  };
}

function normalizeParsedRecord(
  parser: TranscriptRecordParser,
  input: TranscriptParseInput,
  value: unknown,
  line: number,
  byteOffset: number,
  byteLength: number,
  observer?: TranscriptInputObserver,
): NormalizedTranscriptRecord {
  try {
    const context = {
      source: input.source,
      sessionId: input.sessionId,
      line,
      byteOffset,
      byteLength,
      observedAt: input.observedAt,
    };
    const result = parser.parseRecord(value, context);
    let observedInputs: TranscriptParseResult['observedInputs'] = [];
    const observationIssues: TranscriptIssue[] = [];
    if (observer !== undefined) {
      try {
        observedInputs = observer.harness === parser.harness ? observer.observe(value, context) : [];
        if (observer.harness !== parser.harness) {
          observationIssues.push(malformedLineIssue(parser, input, 'invalid-record', line, byteOffset, byteLength));
        }
      } catch {
        observationIssues.push(malformedLineIssue(parser, input, 'invalid-record', line, byteOffset, byteLength));
      }
    }
    return {
      ...result,
      observedInputs,
      issues: [
        ...result.issues.map(issue => ({
          ...issue,
          byteOffset: issue.byteOffset ?? byteOffset,
          byteLength: issue.byteLength ?? byteLength,
        })),
        ...observationIssues,
      ],
    };
  } catch {
    return {
      events: [],
      observedInputs: [],
      issues: [malformedLineIssue(parser, input, 'invalid-record', line, byteOffset, byteLength)],
      recognized: true,
    };
  }
}

const LINE_FEED = 0x0a;

/**
 * One physical record, as THIS function decides record boundaries — the single owner of that
 * decision, so nothing downstream may split a transcript again on its own idea of where a line ends.
 */
interface PhysicalTranscriptRecord {
  /** Absolute file offset of the record's first byte. */
  readonly byteOffset: number;
  /** The record's own length, terminator EXCLUDED: the length an issue reports. */
  readonly byteLength: number;
  /** The record text, terminator excluded, as the JSON reader sees it. */
  readonly body: string;
  /** True when a line terminator ended this record, false when the input simply stopped. */
  readonly terminated: boolean;
  /** The verbatim slice, terminator INCLUDED, present only when raw bytes were supplied. */
  readonly bytes?: Uint8Array;
}

/**
 * Split the RAW BYTES at line feeds, and decode only each already-bounded record.
 *
 * THIS IS THE ONLY HONEST SPLIT. `Buffer.toString('utf8')` replaces every invalid byte sequence with
 * U+FFFD irreversibly, so a boundary or a length taken from decoded text is a boundary in a file
 * nobody has: two different malformed records both decode to the replacement character, collapse to
 * one commitment, and become free to replace each other at the same coordinate. Transcripts are
 * agent-written and can be cut mid-character by a crash, so that is an ordinary input rather than a
 * hypothetical one. Splitting on the byte 0x0A cannot cut a multi-byte character, because no
 * continuation byte can be 0x0A — the split is exact, and each record's decode is independent.
 *
 * Offsets are byte offsets throughout: `byteLength` excludes the terminator, and the next record
 * starts after it.
 */
function byteRecords(bytes: Uint8Array, startByteOffset: number): readonly PhysicalTranscriptRecord[] {
  const decoder = new TextDecoder();
  const records: PhysicalTranscriptRecord[] = [];
  let index = 0;
  while (index < bytes.byteLength) {
    const feed = bytes.indexOf(LINE_FEED, index);
    const terminated = feed >= 0;
    const bodyEnd = terminated ? feed : bytes.byteLength;
    const sliceEnd = terminated ? feed + 1 : bytes.byteLength;
    records.push({
      byteOffset: startByteOffset + index,
      byteLength: bodyEnd - index,
      body: decoder.decode(bytes.subarray(index, bodyEnd)),
      terminated,
      // Copied, not viewed: evidence must not change meaning if the read buffer is reused, and a
      // terminal record is retained exactly as long as it is, with no terminator invented for it.
      bytes: bytes.slice(index, sliceEnd),
    });
    index = sliceEnd;
  }
  return records;
}

/**
 * The legacy split, for a caller that supplies only decoded text.
 *
 * It yields the same boundaries and the same lengths for valid UTF-8 and emits NO record bytes: a
 * re-encoded string cannot promise an exact slice, and evidence that is only usually exact is worse
 * than none. Every consumer of record evidence refuses its absence.
 */
function textRecords(text: string, startByteOffset: number): readonly PhysicalTranscriptRecord[] {
  const records: PhysicalTranscriptRecord[] = [];
  let characterOffset = 0;
  let byteOffset = startByteOffset;
  while (characterOffset < text.length) {
    const newline = text.indexOf('\n', characterOffset);
    const terminated = newline >= 0;
    const body = text.slice(characterOffset, terminated ? newline : text.length);
    records.push({ byteOffset, byteLength: utf8Length(body), body, terminated });
    byteOffset += utf8Length(body) + (terminated ? 1 : 0);
    characterOffset = terminated ? newline + 1 : text.length;
  }
  return records;
}

export function parseTranscriptJsonl(
  parser: TranscriptRecordParser,
  input: TranscriptParseInput,
  observer?: TranscriptInputObserver,
): TranscriptParseResult {
  const events = [] as TranscriptParseResult['events'][number][];
  const observedInputs = [] as TranscriptParseResult['observedInputs'][number][];
  const issues: TranscriptIssue[] = [];
  const startLine = Math.max(1, input.startLine ?? 1);
  const startByteOffset = input.startByteOffset ?? 0;
  const endOfInput = input.endOfInput ?? true;
  let parsedRecords = 0;
  let ignoredRecords = 0;
  let line = startLine;
  const bufferByteOffset = Number.isFinite(startByteOffset) ? Math.max(0, Math.floor(startByteOffset)) : 0;

  const consume = (rawLine: string, complete: boolean, byteOffset: number, byteLength: number): boolean => {
    const withoutReturn = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    // A byte-order mark is legal UTF-8 but illegal JSON whitespace, so an editor-written transcript
    // would otherwise lose its first record to a syntax error.
    const normalizedLine = stripByteOrderMark(withoutReturn);
    if (normalizedLine.trim().length === 0) return true;

    let value: unknown;
    try {
      value = JSON.parse(normalizedLine) as unknown;
    } catch {
      issues.push(
        malformedLineIssue(parser, input, complete ? 'invalid-json' : 'truncated-json', line, byteOffset, byteLength),
      );
      return false;
    }

    const result = normalizeParsedRecord(parser, input, value, line, byteOffset, byteLength, observer);
    events.push(...result.events);
    observedInputs.push(...result.observedInputs);
    issues.push(...result.issues);
    parsedRecords += 1;
    if (!result.recognized) ignoredRecords += 1;
    return true;
  };

  // The bytes are authoritative when they are supplied: `text` is a decoding of them, and a decoding
  // cannot answer where a record starts in a file. Evidence is emitted only on that path.
  const sourceBytes = input.bytes;
  const records =
    sourceBytes === undefined ? textRecords(input.text, bufferByteOffset) : byteRecords(sourceBytes, bufferByteOffset);
  const rawRecords: TranscriptRawRecord[] | undefined = sourceBytes === undefined ? undefined : [];

  let remainder = '';
  for (const record of records) {
    if (!record.terminated && !endOfInput) {
      // A live writer's unterminated tail is not a record yet. Nothing is emitted for it, so no
      // commitment can ever cover half a line that is still being written.
      remainder = record.body;
      issues.push(malformedLineIssue(parser, input, 'incomplete-line', line, record.byteOffset, record.byteLength));
      break;
    }
    // Every complete record is reported, blank and unrecognised ones included: they occupy their
    // byte range whatever the normalizer made of them, and a chain that skipped them would commit
    // to a file that does not exist.
    if (rawRecords !== undefined && record.bytes !== undefined)
      rawRecords.push({ byteOffset: record.byteOffset, bytes: record.bytes });
    const parsed = consume(record.body, record.terminated, record.byteOffset, record.byteLength);
    if (record.terminated) line += 1;
    else if (!parsed) remainder = record.body;
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
