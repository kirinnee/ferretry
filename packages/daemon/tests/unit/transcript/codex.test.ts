import { describe, it } from 'bun:test';
import should from 'should';
import fixture from '../../fixtures/transcript/codex.jsonl' with { type: 'text' };
import { CodexTranscriptParser } from '../../../src/lib/transcript/codex.ts';

describe('CodexTranscriptParser', () => {
  it('should normalize the synthetic fixture into the common event model', () => {
    // Arrange
    const subject = new CodexTranscriptParser();

    // Act
    const actual = subject.parse({ text: fixture, source: 'codex.jsonl', sessionId: 'session-synthetic' });

    // Assert
    should(actual.issues).have.length(0);
    should(actual.events).have.length(12);
    should(actual.events.map(event => event.kind)).deepEqual([
      'message',
      'attachment',
      'message',
      'reasoning',
      'tool-call',
      'tool-result',
      'usage',
      'settings',
      'turn',
      'turn',
      'message',
      'error',
    ]);
    should(actual.events[0]).containDeep({ harness: 'codex', sessionId: 'session-synthetic', role: 'user' });
    should(actual.events[1]).containDeep({ attachment: { kind: 'image', uri: 'fixture://image-1' } });
    should(actual.events[4]).containDeep({
      call: { id: 'call-question', name: 'request_user_input', questions: [{ question: 'Which synthetic option?' }] },
    });
    should(actual.events[6]).containDeep({
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cachedInputTokens: 10,
        reasoningTokens: 2,
        contextTokens: 25,
        contextWindow: 128000,
      },
    });
    should(actual.events[7]).containDeep({ settings: { model: 'gpt-synthetic', reasoningEffort: 'high' } });
    should(actual.events[10]).containDeep({ kind: 'message', role: 'system', text: 'Synthetic context summary.' });
    should(actual.events[11]).containDeep({ error: { code: 'fixture_error', recoverable: true } });
  });

  it('should preserve malformed embedded tool arguments and report them', () => {
    // Arrange
    const subject = new CodexTranscriptParser();
    const input = {
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{broken' },
    };

    // Act
    const actual = subject.parseRecord(input, { line: 3 });

    // Assert
    should(actual.events).have.length(1);
    should(actual.events[0]).containDeep({ call: { id: 'call-1', input: '{broken' } });
    should(actual.issues).have.length(1);
    should(actual.issues[0]).containDeep({ code: 'invalid-tool-input', line: 3 });
  });

  it('should report response-item drift instead of classifying it by a name suffix', () => {
    // Arrange
    const subject = new CodexTranscriptParser();
    const input = { type: 'response_item', payload: { type: 'future_magic_call', call_id: 'call-future' } };

    // Act
    const actual = subject.parseRecord(input);

    // Assert
    should(actual.events).have.length(0);
    should(actual.issues).containDeep([{ code: 'unsupported-record', recordType: 'future_magic_call' }]);
  });

  it('should model aborted turns, local tools, and failed results explicitly', () => {
    // Arrange
    const subject = new CodexTranscriptParser();
    const inputs = [
      { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 'turn-2', message: 'Synthetic abort.' } },
      { type: 'response_item', payload: { type: 'local_shell_call', call_id: 'call-shell', action: ['pwd'] } },
      {
        type: 'response_item',
        payload: { type: 'local_shell_call_output', call_id: 'call-shell', output: 'failed', status: 'cancelled' },
      },
    ];

    // Act
    const actual = inputs.flatMap(input => subject.parseRecord(input).events);

    // Assert
    should(actual).containDeep([
      { kind: 'turn', state: 'aborted', turnId: 'turn-2' },
      { kind: 'error', error: { message: 'Synthetic abort.' } },
      { kind: 'tool-call', call: { id: 'call-shell', name: 'local_shell', input: ['pwd'] } },
      { kind: 'tool-result', result: { callId: 'call-shell', isError: true } },
    ]);
  });

  it('should return structured issues for malformed known records', () => {
    // Arrange
    const subject = new CodexTranscriptParser();
    const cases = [
      { type: 'turn_context', payload: {} },
      { type: 'compacted', payload: {} },
      { type: 'event_msg', payload: { type: 'agent_reasoning' } },
      { type: 'response_item', payload: { role: 'user' } },
      { type: 'response_item', payload: { type: 'message', role: 'invalid', content: [] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'missing-id' } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'missing-id' } },
    ];

    // Act
    const actual = cases.map(input => subject.parseRecord(input));

    // Assert
    should(actual.every(result => result.events.length === 0)).be.true();
    should(actual.every(result => result.issues[0]?.code === 'invalid-record')).be.true();
  });

  it('should normalize a top-level error without requiring a nested payload', () => {
    // Arrange
    const subject = new CodexTranscriptParser();

    // Act
    const actual = subject.parseRecord({ type: 'error', message: 'Synthetic top-level failure.', code: 'fixture' });

    // Assert
    should(actual.issues).be.empty();
    should(actual.events).containDeep([
      {
        kind: 'error',
        error: { message: 'Synthetic top-level failure.', code: 'fixture', recoverable: true },
      },
    ]);
  });
});
