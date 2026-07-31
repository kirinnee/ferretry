import { describe, it } from 'bun:test';
import should from 'should';
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';
import { CodexTranscriptParser } from '../../../src/lib/transcript/codex.ts';
import { parseTranscriptJsonl } from '../../../src/lib/transcript/jsonl.ts';
import type { TranscriptParser } from '../../../src/lib/transcript/types.ts';

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
      should(actual.issues.map(issue => issue.code)).deepEqual(['invalid-json', 'truncated-json']);
      should(actual.remainder).equal('{"truncated":');
      should(actual.parsedRecords).equal(2);
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
});
