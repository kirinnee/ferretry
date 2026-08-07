import { describe, it } from 'bun:test';
import should from 'should';
import {
  extendSessionTranscriptRawPrefix,
  sessionTranscriptRawPrefixStart,
} from '../../../src/lib/session/transcript/message-token.ts';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../src/lib/transcript/codex.ts';
import { parseTranscriptJsonl } from '../../../src/lib/transcript/jsonl.ts';
import type {
  TranscriptInputObserver,
  TranscriptParser,
  TranscriptRawRecord,
} from '../../../src/lib/transcript/types.ts';

interface ParserFixture {
  readonly name: string;
  readonly subject: TranscriptParser;
  readonly record: Record<string, unknown>;
}

const fixtures: readonly ParserFixture[] = [
  {
    name: 'Claude',
    subject: new ClaudeTranscriptParser(),
    record: { type: 'user', message: { role: 'user', content: 'first' } },
  },
  {
    name: 'Codex',
    subject: new CodexTranscriptParser(),
    record: {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] },
    },
  },
];

function parserContract(fixture: ParserFixture): void {
  describe(`${fixture.name} transcript parser contract`, () => {
    it('should parse complete records around malformed and truncated JSON without throwing', () => {
      // Arrange
      const valid = JSON.stringify(fixture.record);
      const input = `${valid}\n{interleaved}\n${valid}\n{"truncated":`;

      // Act
      const actual = fixture.subject.parse({ text: input, source: 'synthetic.jsonl' });

      // Assert
      should(actual.events).have.length(2);
      should(actual.events[0]).containDeep({
        source: 'synthetic.jsonl',
        line: 1,
        byteOffset: 0,
        byteLength: valid.length,
      });
      should(actual.events[1]).containDeep({
        source: 'synthetic.jsonl',
        line: 3,
        byteOffset: Buffer.byteLength(`${valid}\n{interleaved}\n`),
        byteLength: valid.length,
      });
      should(actual.issues.map(issue => issue.code)).deepEqual(['invalid-json', 'truncated-json']);
      should(actual.remainder).equal('{"truncated":');
      should(actual.parsedRecords).equal(2);
    });

    it('should survive hostile line encodings without discarding the surrounding records', () => {
      // Arrange: a BOM, CRLF terminators, an embedded NUL and a lone surrogate — everything an
      // agent-written transcript picks up from an editor, a crash, or a hostile tool result.
      const valid = JSON.stringify(fixture.record);
      const withNul = `{"content":"a${'\u0000'}b"}`;
      const withSurrogate = JSON.stringify({ ...fixture.record, marker: '\ud800' });
      const input = `\uFEFF${valid}\r\n${withNul}\r\n${withSurrogate}\r\n${valid}\r\n`;

      // Act
      const actual = fixture.subject.parse({ text: input, source: 'hostile.jsonl' });

      // Assert
      should(actual.parsedRecords).equal(3);
      should(actual.events).have.length(3);
      should(actual.issues.filter(issue => issue.code === 'invalid-json')).have.length(1);
      should(actual.issues[0]?.line).equal(2);
      should(actual.remainder).equal('');
    });

    it('should retain any live unterminated line even when it is already valid JSON', () => {
      // Arrange
      const input = JSON.stringify(fixture.record);

      // Act
      const actual = fixture.subject.parse({ text: input, endOfInput: false, startLine: 7 });

      // Assert
      should(actual.events).have.length(0);
      should(actual.issues).have.length(1);
      should(actual.issues[0]?.code).equal('incomplete-line');
      should(actual.issues[0]?.line).equal(7);
      should(actual.remainder).equal(input);
    });

    it('should accept a complete final record without a newline when input is final', () => {
      // Arrange
      const input = JSON.stringify(fixture.record);

      // Act
      const actual = fixture.subject.parse({ text: input, endOfInput: true });

      // Assert
      should(actual.events).have.length(1);
      should(actual.issues).have.length(0);
      should(actual.remainder).equal('');
    });

    it('should use the parser input session id when the record omits one', () => {
      // Arrange
      const input = JSON.stringify(fixture.record);

      // Act
      const actual = fixture.subject.parse({ text: input, sessionId: 'session-from-source' });

      // Assert
      should(actual.events).not.be.empty();
      should(actual.events.every(event => event.sessionId === 'session-from-source')).be.true();
    });

    it('should ignore blank CRLF lines and count unknown valid records', () => {
      // Arrange
      const input = `\r\n${JSON.stringify({ type: 'synthetic-unknown' })}\r\n`;

      // Act
      const actual = fixture.subject.parse({ text: input });

      // Assert
      should(actual.events).have.length(0);
      should(actual.issues).have.length(0);
      should(actual.parsedRecords).equal(1);
      should(actual.ignoredRecords).equal(1);
    });

    it('should return a structured issue for a non-object record', () => {
      // Act
      const actual = fixture.subject.parse({ text: '42\n' });

      // Assert
      should(actual.events).have.length(0);
      should(actual.issues).have.length(1);
      should(actual.issues[0]?.code).equal('invalid-record');
    });

    it('should report malformed-line byte offsets relative to the supplied file position', () => {
      // Act
      const actual = fixture.subject.parse({ text: '{broken}\n', startByteOffset: 41 });

      // Assert
      should(actual.issues).containDeep([{ code: 'invalid-json', byteOffset: 41, byteLength: 8 }]);
    });

    it('should enrich semantic record issues with the record byte range', () => {
      // Arrange
      const valid = JSON.stringify(fixture.record);
      const invalid = JSON.stringify(
        fixture.name === 'Claude'
          ? {
              type: 'assistant',
              message: { role: 'assistant', content: [{ type: 'tool_use', name: 'missing-id' }] },
            }
          : { type: 'response_item', payload: { type: 'function_call', name: 'missing-id' } },
      );

      // Act
      const actual = fixture.subject.parse({ text: `${valid}\n${invalid}\n`, startByteOffset: 17 });

      // Assert
      should(actual.issues[0]).containDeep({
        line: 2,
        byteOffset: 17 + Buffer.byteLength(`${valid}\n`),
        byteLength: Buffer.byteLength(invalid),
      });
    });
  });
}

for (const fixture of fixtures) parserContract(fixture);

describe('JSONL normalization boundary', () => {
  it('should turn an unexpected record-normalizer failure into a structured issue', () => {
    // Arrange
    const subject = {
      harness: 'claude' as const,
      parseRecord(): never {
        throw new Error('synthetic normalizer failure');
      },
    };

    // Act
    const actual = parseTranscriptJsonl(subject, { text: '{}\n' });

    // Assert
    should(actual.events).have.length(0);
    should(actual.issues).containDeep([{ code: 'invalid-record', recoverable: true }]);
  });

  it('should keep normalized history when an input observer is mismatched or fails', () => {
    // Arrange
    const parser = {
      harness: 'claude' as const,
      parseRecord() {
        return {
          events: [{ harness: 'claude' as const, role: 'user' as const, kind: 'message' as const, text: 'kept' }],
          issues: [],
          recognized: true,
        };
      },
    };
    const observers: TranscriptInputObserver[] = [
      { harness: 'codex', observe: () => [], reset() {} },
      {
        harness: 'claude',
        observe(): never {
          throw new Error('synthetic observer failure');
        },
        reset() {},
      },
    ];

    // Act
    const actual = observers.map(observer => parseTranscriptJsonl(parser, { text: '{}\n' }, observer));

    // Assert
    should(actual.every(result => result.events[0]?.kind === 'message')).be.true();
    should(actual.every(result => result.observedInputs.length === 0)).be.true();
    should(actual.every(result => result.issues[0]?.code === 'invalid-record')).be.true();
  });
});

/**
 * The parser is the ONE owner of where a physical record starts and ends, and the only place those
 * boundaries become exact bytes.
 *
 * Every property here is what the selection commitment rests on. If a boundary here disagreed with
 * the byte offset an event carries, a fork would be bound to its neighbour's content; if a slice
 * were re-encoded from decoded text, two different malformed records would share one commitment.
 */
describe('physical record evidence', () => {
  const parser = new ClaudeTranscriptParser();
  const message = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

  const parseBytes = (bytes: Uint8Array, endOfInput = true): readonly TranscriptRawRecord[] | undefined =>
    parseTranscriptJsonl(parser, {
      text: new TextDecoder().decode(bytes),
      bytes,
      source: 'synthetic.jsonl',
      endOfInput,
    }).rawRecords;

  const chainOf = (records: readonly TranscriptRawRecord[]): Uint8Array =>
    records.reduce(
      (previous, record) => extendSessionTranscriptRawPrefix(previous, record.bytes),
      sessionTranscriptRawPrefixStart(),
    );

  it('should emit each record verbatim, terminator included, at its own byte offset', () => {
    // Arrange
    const bytes = Buffer.from(`${message('first')}\n${message('second')}\n`, 'utf8');

    // Act
    const records = parseBytes(bytes) ?? [];

    // Assert
    should(records).have.length(2);
    should(records[0]?.byteOffset).equal(0);
    should(Buffer.from(records[0]?.bytes ?? []).toString('utf8')).equal(`${message('first')}\n`);
    should(records[1]?.byteOffset).equal(Buffer.byteLength(`${message('first')}\n`, 'utf8'));
    should(Buffer.concat(records.map(record => Buffer.from(record.bytes))).equals(bytes)).be.true();
  });

  it('should keep CRLF and blank and unrecognised records in the sequence', () => {
    // Arrange: a blank line and a record no harness normalizer recognises still occupy their bytes.
    const bytes = Buffer.from(`${message('first')}\r\n\n{"unrecognised":true}\n`, 'utf8');

    // Act
    const records = parseBytes(bytes) ?? [];

    // Assert
    should(records.map(record => Buffer.from(record.bytes).toString('utf8'))).deepEqual([
      `${message('first')}\r\n`,
      '\n',
      '{"unrecognised":true}\n',
    ]);
    should(records.map(record => record.byteOffset)).deepEqual([
      0,
      Buffer.byteLength(`${message('first')}\r\n`, 'utf8'),
      Buffer.byteLength(`${message('first')}\r\n\n`, 'utf8'),
    ]);
  });

  it('should keep a terminal record exactly as long as it is, inventing no terminator', () => {
    // Arrange
    const bytes = Buffer.from(`${message('first')}\n${message('last')}`, 'utf8');

    // Act
    const records = parseBytes(bytes) ?? [];

    // Assert
    should(Buffer.from(records[1]?.bytes ?? []).toString('utf8')).equal(message('last'));
    should(Buffer.from(records[1]?.bytes ?? []).at(-1)).not.equal(0x0a);
  });

  it('should emit no record for an unterminated tail a live writer is still writing', () => {
    // Arrange
    const bytes = Buffer.from(`${message('first')}\n{"half":`, 'utf8');

    // Act
    const records = parseBytes(bytes, false) ?? [];

    // Assert: half a line has no commitment, because it is not a record yet.
    should(records).have.length(1);
    should(Buffer.from(records[0]?.bytes ?? []).toString('utf8')).equal(`${message('first')}\n`);
  });

  it('should keep two DIFFERENT invalid-UTF-8 records at different commitments', () => {
    // Arrange: both decode to the SAME replacement character, which is exactly how a chain built
    // from decoded text collapses them and lets either replace the other at one coordinate.
    const left = Buffer.concat([Buffer.from('{"a":"'), Buffer.of(0xff), Buffer.from('"}\n')]);
    const right = Buffer.concat([Buffer.from('{"a":"'), Buffer.of(0xfe), Buffer.from('"}\n')]);

    // Act
    const leftRecords = parseBytes(left) ?? [];
    const rightRecords = parseBytes(right) ?? [];

    // Assert
    should(new TextDecoder().decode(left)).equal(new TextDecoder().decode(right));
    should(Buffer.from(leftRecords[0]?.bytes ?? []).equals(left)).be.true();
    should(Buffer.from(chainOf(leftRecords)).equals(Buffer.from(chainOf(rightRecords)))).be.false();
  });

  it('should separate two records from one record carrying the same bytes', () => {
    // Arrange
    const split = Buffer.from(`${message('a')}\n${message('b')}\n`, 'utf8');
    const joined = Buffer.from(`${message('a')}${message('b')}\n`, 'utf8');

    // Act / Assert
    should(
      Buffer.from(chainOf(parseBytes(split) ?? [])).equals(Buffer.from(chainOf(parseBytes(joined) ?? []))),
    ).be.false();
  });

  it('should agree with the byte offsets it reports on its own events', () => {
    // Arrange: a multi-byte character before the second record, so a character count and a byte
    // count disagree — the drift a chain must never inherit.
    const bytes = Buffer.from(`${message('héllo wörld')}\n${message('second')}\n`, 'utf8');

    // Act
    const parsed = parseTranscriptJsonl(parser, {
      text: bytes.toString('utf8'),
      bytes,
      source: 'synthetic.jsonl',
    });

    // Assert: every event's coordinate names a record this parse emitted.
    const offsets = new Set((parsed.rawRecords ?? []).map(record => record.byteOffset));
    should(parsed.events).not.be.empty();
    should(parsed.events.every(event => event.byteOffset !== undefined && offsets.has(event.byteOffset))).be.true();
  });

  it('should emit no evidence at all for a text-only caller', () => {
    // Arrange: a re-encoding cannot promise an exact slice, so none is offered.
    // Act
    const parsed = parseTranscriptJsonl(parser, { text: `${message('first')}\n`, source: 'synthetic.jsonl' });

    // Assert
    should(parsed.rawRecords).be.undefined();
    should(parsed.events).have.length(1);
  });
});
