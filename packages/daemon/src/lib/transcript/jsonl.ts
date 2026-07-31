import type {
  TranscriptIssue,
  TranscriptInputObserver,
  TranscriptParseInput,
  TranscriptParseResult,
  TranscriptParser,
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

/** Parse JSONL without throwing, retaining a live writer's unterminated tail. */
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
  let characterOffset = 0;
  let byteOffset = Number.isFinite(startByteOffset) ? Math.max(0, Math.floor(startByteOffset)) : 0;

  const consume = (rawLine: string, complete: boolean): boolean => {
    const withoutReturn = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    // A byte-order mark is legal UTF-8 but illegal JSON whitespace, so an editor-written transcript
    // would otherwise lose its first record to a syntax error.
    const normalizedLine = stripByteOrderMark(withoutReturn);
    const byteLength = utf8Length(rawLine);
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

  while (characterOffset < input.text.length) {
    const newline = input.text.indexOf('\n', characterOffset);
    if (newline < 0) break;
    const rawLine = input.text.slice(characterOffset, newline);
    consume(rawLine, true);
    const consumed = input.text.slice(characterOffset, newline + 1);
    byteOffset += utf8Length(consumed);
    characterOffset = newline + 1;
    line += 1;
  }

  const tail = input.text.slice(characterOffset);
  let remainder = '';
  if (tail.length > 0) {
    if (endOfInput) {
      if (!consume(tail, false)) remainder = tail;
    } else {
      remainder = tail;
      issues.push(malformedLineIssue(parser, input, 'incomplete-line', line, byteOffset, utf8Length(tail)));
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
  };
}
