import { describe, it } from 'bun:test';
import should from 'should';
import fixture from '../../fixtures/transcript/claude.jsonl' with { type: 'text' };
import { ClaudeTranscriptParser } from '../../../src/lib/transcript/claude.ts';

describe('ClaudeTranscriptParser', () => {
  it('should normalize the synthetic fixture into the common event model', () => {
    // Arrange
    const subject = new ClaudeTranscriptParser();

    // Act
    const actual = subject.parse({ text: fixture, source: 'claude.jsonl', observedAt: '2026-01-02T03:04:12.000Z' });

    // Assert
    should(actual.issues).have.length(0);
    should(actual.events).have.length(13);
    should(actual.observedInputs.map(input => input.text)).deepEqual([
      'Please inspect the synthetic fixture.',
      'The fixture includes an image.',
      'Continue with the synthetic case.',
    ]);
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
      'message',
      'attachment',
      'error',
    ]);
    should(actual.events[0]).containDeep({
      harness: 'claude',
      role: 'user',
      text: 'Please inspect the synthetic fixture.',
    });
    should(actual.events[2]).containDeep({ kind: 'attachment', attachment: { kind: 'image', name: 'fixture.png' } });
    should(actual.events[3]).containDeep({ kind: 'reasoning', stopReason: 'tool_use' });
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
    should(actual.events[10]).containDeep({ kind: 'message', role: 'user', inputSource: 'native-queue' });
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
    should(actual.issues).containDeep([
      { recordType: 'assistant', blockType: 'tool_use' },
      { recordType: 'assistant', blockType: 'future_block' },
    ]);
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
      {},
      { type: 'system', subtype: 'error', error: {} },
      { type: 'user', message: { role: 'user', content: [null] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: ' ', name: 'Bash' }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: ' ' }] } },
    ];

    // Act
    const actual = cases.map(input => subject.parseRecord(input));

    // Assert
    should(actual.every(result => result.events.length === 0)).be.true();
    should(actual.every(result => result.issues[0]?.code === 'invalid-record')).be.true();
  });

  it('should suppress an all-zero usage block', () => {
    // Arrange
    const subject = new ClaudeTranscriptParser();
    const input = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };

    // Act
    const actual = subject.parseRecord(input);

    // Assert
    should(actual.events).be.empty();
    should(actual.issues).be.empty();
  });

  it('should accept only provenance-marked human queue prompts and trusted remote-control URLs', () => {
    // Arrange
    const subject = new ClaudeTranscriptParser();
    const queued = (overrides: Record<string, unknown>) => ({
      type: 'attachment',
      attachment: {
        type: 'queued_command',
        prompt: 'Synthetic queued prompt.',
        commandMode: 'prompt',
        origin: { kind: 'human' },
        ...overrides,
      },
    });
    const bridge = (url: unknown) => ({
      type: 'system',
      subtype: 'bridge_status',
      content: 'Remote control prose must not become chat.',
      url,
    });

    // Act
    const rejectedQueues = [
      queued({ commandMode: 'task-notification' }),
      queued({ origin: undefined }),
      queued({ origin: { kind: 'task' } }),
      queued({ prompt: '   ' }),
    ].map(record => subject.parseRecord(record));
    const rejectedBridges = [bridge(undefined), bridge('https://example.invalid/code/session')].map(record =>
      subject.parseRecord(record),
    );
    const accepted = subject.parseRecord(queued({}));
    const remote = subject.parseRecord(bridge('https://claude.ai/code/session_synthetic'));

    // Assert
    should(rejectedQueues.every(result => result.events.length === 0)).be.true();
    should(rejectedBridges.every(result => result.events.length === 0)).be.true();
    should(accepted.events).containDeep([
      { role: 'user', kind: 'message', text: 'Synthetic queued prompt.', inputSource: 'native-queue' },
    ]);
    should(remote.events).containDeep([{ role: 'system', kind: 'attachment', attachment: { kind: 'remote-control' } }]);
  });

  it('should reject empty attachments and diagnose partially malformed questions', () => {
    // Arrange
    const subject = new ClaudeTranscriptParser();
    const question = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-question',
            name: 'AskUserQuestion',
            input: {
              questions: [
                { question: 'Keep this?', options: [{ label: 'Yes' }, { description: 'missing label' }] },
                { options: [] },
              ],
            },
          },
          { type: 'image', name: 'empty.png' },
        ],
      },
    };

    // Act
    const actual = subject.parseRecord(question);

    // Assert
    should(actual.events).containDeep([
      { kind: 'tool-call', call: { questions: [{ question: 'Keep this?', options: [{ label: 'Yes' }] }] } },
    ]);
    should(actual.issues).containDeep([
      { code: 'invalid-tool-input', recordType: 'assistant', blockType: 'tool_use' },
      { code: 'invalid-record', recordType: 'assistant', blockType: 'image' },
    ]);
  });

  it('should extract tool-result text only from strings and typed text blocks', () => {
    // Arrange
    const subject = new ClaudeTranscriptParser();
    const result = (content: unknown) =>
      subject.parseRecord({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content }] },
      });

    // Act
    const plain = result('plain output');
    const mixed = result([
      { type: 'image', text: 'image metadata is not tool output' },
      { type: 'text', text: 'typed output' },
    ]);
    const object = result({ type: 'text', text: 'object-shaped content is not a text block list' });

    // Assert
    should(plain.events).containDeep([{ kind: 'tool-result', result: { text: 'plain output' } }]);
    should(mixed.events).containDeep([{ kind: 'tool-result', result: { text: 'typed output' } }]);
    should(object.events).containDeep([{ kind: 'tool-result', result: { text: undefined } }]);
  });
});
