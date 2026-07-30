import { describe, it } from 'bun:test';
import should from 'should';
import fixture from '../../fixtures/transcript/claude.jsonl' with { type: 'text' };
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';

describe('ClaudeTranscriptParser', () => {
  it('should normalize the synthetic fixture into the common event model', () => {
    // Arrange
    const subject = new ClaudeTranscriptParser();

    // Act
    const actual = subject.parse({ text: fixture, source: 'claude.jsonl' });

    // Assert
    should(actual.issues).have.length(0);
    should(actual.events).have.length(13);
    should(actual.events.map(event => event.kind)).deepEqual([
      'message',
      'message',
      'attachment',
      'reasoning',
      'message',
      'tool-call',
      'usage',
      'tool-result',
      'message',
      'turn',
      'attachment',
      'attachment',
      'error',
    ]);
    should(actual.events[0]).containDeep({
      harness: 'claude',
      role: 'user',
      text: 'Please inspect the synthetic fixture.',
    });
    should(actual.events[2]).containDeep({ kind: 'attachment', attachment: { kind: 'image', name: 'fixture.png' } });
    should(actual.events[5]).containDeep({
      kind: 'tool-call',
      call: { id: 'tool-question', name: 'AskUserQuestion', questions: [{ question: 'Which synthetic option?' }] },
    });
    should(actual.events[6]).containDeep({
      kind: 'usage',
      usage: { inputTokens: 12, outputTokens: 4, contextTokens: 17, model: 'claude-synthetic' },
    });
    should(actual.events[7]).containDeep({
      kind: 'tool-result',
      role: 'tool',
      result: { callId: 'tool-question', text: 'Alpha selected.', isError: false },
    });
    should(actual.events[10]).containDeep({ attachment: { kind: 'queued-command', origin: 'human' } });
    should(actual.events[12]).containDeep({ error: { code: 'fixture_error', recoverable: true } });
  });

  it('should keep valid blocks while reporting malformed and unsupported blocks', () => {
    // Arrange
    const subject = new ClaudeTranscriptParser();
    const input = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'still valid' },
          { type: 'tool_use', name: 'Bash' },
          { type: 'future_block', value: true },
        ],
      },
    };

    // Act
    const actual = subject.parseRecord(input, { line: 4 });

    // Assert
    should(actual.events).have.length(1);
    should(actual.events[0]).containDeep({ kind: 'message', text: 'still valid' });
    should(actual.issues.map(issue => issue.code)).deepEqual(['invalid-record', 'unsupported-record']);
    should(actual.issues.every(issue => issue.line === 4)).be.true();
  });

  it('should model document, file, and in-band error blocks explicitly', () => {
    // Arrange
    const subject = new ClaudeTranscriptParser();
    const input = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'document', name: 'notes.txt', text: 'synthetic notes', media_type: 'text/plain' },
          { type: 'attachment', name: 'archive.bin', uri: 'fixture://archive' },
          { type: 'error', message: 'Synthetic block error.', code: 'block_error' },
        ],
      },
    };

    // Act
    const actual = subject.parseRecord(input);

    // Assert
    should(actual.issues).have.length(0);
    should(actual.events).containDeep([
      { kind: 'attachment', attachment: { kind: 'document', text: 'synthetic notes' } },
      { kind: 'attachment', attachment: { kind: 'file', uri: 'fixture://archive' } },
      { kind: 'error', error: { message: 'Synthetic block error.', code: 'block_error' } },
    ]);
  });

  it('should reject malformed typed records without inventing chat messages', () => {
    // Arrange
    const subject = new ClaudeTranscriptParser();
    const cases = [
      { type: 'system', subtype: 'error', error: {} },
      { type: 'user', message: { role: 'user', content: [null] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } },
    ];

    // Act
    const actual = cases.map(input => subject.parseRecord(input));

    // Assert
    should(actual.every(result => result.events.length === 0)).be.true();
    should(actual.every(result => result.issues[0]?.code === 'invalid-record')).be.true();
  });
});
