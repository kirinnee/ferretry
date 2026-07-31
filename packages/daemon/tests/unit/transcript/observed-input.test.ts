import { describe, it } from 'bun:test';
import should from 'should';
import {
  CLAUDE_INPUT_SHAPE_VERSION,
  ClaudeObservedInputObserver,
  CODEX_INPUT_SHAPE_VERSION,
  CodexObservedInputObserver,
} from '../../../src/lib/transcript/observed-input.ts';
import type { TranscriptObservationContext } from '../../../src/lib/transcript/types.ts';

const FALLBACK = '2026-07-27T09:00:00.000Z';

function context(byteOffset = 10, byteLength = 50): TranscriptObservationContext {
  return { source: '/synthetic/transcript.jsonl', byteOffset, byteLength, observedAt: FALLBACK };
}

function claudeUser(content: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'user',
    uuid: 'claude-record',
    timestamp: '2026-01-02T03:04:05.000Z',
    message: { role: 'user', content },
    ...overrides,
  };
}

function queuedClaude(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'attachment',
    uuid: 'claude-queued',
    timestamp: '2026-01-02T03:04:06.000Z',
    attachment: {
      type: 'queued_command',
      prompt: text,
      commandMode: 'prompt',
      origin: { kind: 'human' },
      timestamp: '2026-01-02T03:04:04.000Z',
      ...overrides,
    },
  };
}

function removeClaude(content: string, timestamp?: string): Record<string, unknown> {
  return { type: 'queue-operation', operation: 'remove', content, timestamp };
}

function codexUser(content: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'response_item',
    timestamp: '2026-01-02T03:04:05.000Z',
    payload: { type: 'message', id: 'codex-message', role: 'user', content, ...overrides },
  };
}

describe('ClaudeObservedInputObserver', () => {
  it('should emit normal user proof while excluding tool results and non-human records', () => {
    // Arrange
    const subject = new ClaudeObservedInputObserver();

    // Act
    const normal = subject.observe(
      claudeUser(['first', { type: 'text', text: 'second' }, { type: 'tool_result', content: 'ignored' }]),
      context(),
    );
    const objectText = subject.observe(claudeUser({ type: 'text', text: 'object text' }), context());
    const rejected = [
      null,
      { type: 'assistant', message: { role: 'assistant', content: 'not human' } },
      claudeUser([{ type: 'tool_result', content: 'tool output' }]),
      claudeUser('   '),
    ].flatMap(value => subject.observe(value, context()));

    // Assert
    should(normal).containDeep([
      {
        harness: 'claude',
        text: 'first\nsecond',
        proof: 'normal-user-record',
        observedAt: '2026-01-02T03:04:05.000Z',
        proofKey: 'claude-record',
        shapeVersion: CLAUDE_INPUT_SHAPE_VERSION,
      },
    ]);
    should(objectText[0]?.text).equal('object text');
    should(rejected).be.empty();
  });

  it('should pair a busy drain one-to-one with the newest matching remove time', () => {
    // Arrange
    const subject = new ClaudeObservedInputObserver();
    subject.observe({ type: 'queue-operation', operation: 'enqueue', content: 'same' }, context());
    subject.observe(removeClaude('same', '2026-01-02T03:04:07.000Z'), context());
    subject.observe(removeClaude('other', '2026-01-02T03:04:08.000Z'), context());
    subject.observe(removeClaude('same', '2026-01-02T03:04:09.000Z'), context());

    // Act
    const first = subject.observe(queuedClaude('same'), context());
    const second = subject.observe(queuedClaude('same', { timestamp: undefined }), context());
    const unpaired = subject.observe(queuedClaude('unpaired'), context());

    // Assert
    should(first).containDeep([
      {
        proof: 'native-queue-drain',
        observedAt: '2026-01-02T03:04:09.000Z',
        originatedAt: '2026-01-02T03:04:04.000Z',
      },
    ]);
    should(second[0]?.observedAt).equal('2026-01-02T03:04:07.000Z');
    should(second[0]?.originatedAt).equal('2026-01-02T03:04:06.000Z');
    should(unpaired[0]?.observedAt).equal(FALLBACK);
  });

  it('should bound and reset remove state and require a trustworthy observation time', () => {
    // Arrange
    const subject = new ClaudeObservedInputObserver();
    for (let index = 0; index < 65; index += 1) {
      subject.observe(removeClaude(`prompt-${index}`, `remove-time-${index}`), context());
    }

    // Act
    const evicted = subject.observe(queuedClaude('prompt-0'), context());
    const retained = subject.observe(queuedClaude('prompt-64'), context());
    subject.observe(removeClaude('reset-prompt', '2026-01-02T03:05:00.000Z'), context());
    subject.reset();
    const reset = subject.observe(queuedClaude('reset-prompt'), context());
    const noTime = subject.observe(claudeUser('no timestamp', { uuid: undefined, timestamp: undefined }), {
      source: '/synthetic/transcript.jsonl',
      byteOffset: 20,
      byteLength: 40,
    });
    const cursorKey = subject.observe(
      claudeUser('cursor key', { uuid: undefined, timestamp: undefined }),
      context(20, 40),
    );

    // Assert
    should(evicted[0]?.observedAt).equal(FALLBACK);
    should(retained[0]?.observedAt).equal('remove-time-64');
    should(reset[0]?.observedAt).equal(FALLBACK);
    should(noTime).be.empty();
    should(cursorKey[0]?.proofKey).equal('/synthetic/transcript.jsonl#20#60');
  });

  it('should reject every malformed busy-queue discriminator and a missing fallback', () => {
    // Arrange
    const subject = new ClaudeObservedInputObserver();
    const records = [
      queuedClaude('valid', { type: 'other' }),
      queuedClaude('valid', { commandMode: 'task-notification' }),
      queuedClaude('valid', { origin: { kind: 'task' } }),
      queuedClaude('   '),
    ];

    // Act
    const malformed = records.flatMap(record => subject.observe(record, context()));
    const noFallback = subject.observe(queuedClaude('no fallback'), { source: '/synthetic/transcript.jsonl' });

    // Assert
    should(malformed).be.empty();
    should(noFallback).be.empty();
  });
});

describe('CodexObservedInputObserver', () => {
  it('should emit only canonical user text and use payload or cursor proof keys', () => {
    // Arrange
    const subject = new CodexObservedInputObserver();

    // Act
    const canonical = subject.observe(
      codexUser([
        'plain',
        { type: 'input_text', text: 'typed' },
        { text: 'untyped' },
        { type: 'output_text', text: 'ignored' },
      ]),
      context(),
    );
    const cursor = subject.observe(
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'cursor text' } },
      context(100, 25),
    );

    // Assert
    should(canonical).containDeep([
      {
        harness: 'codex',
        text: 'plain\ntyped\nuntyped',
        proof: 'normal-user-record',
        observedAt: '2026-01-02T03:04:05.000Z',
        proofKey: 'codex-message',
        shapeVersion: CODEX_INPUT_SHAPE_VERSION,
      },
    ]);
    should(cursor[0]).containDeep({ observedAt: FALLBACK, proofKey: '/synthetic/transcript.jsonl#100#125' });
  });

  it('should exclude mirrors, non-users, blanks, preambles, malformed records, and records with no time', () => {
    // Arrange
    const subject = new CodexObservedInputObserver();
    const preambles = ['environment_context', 'user_instructions', 'user_environment'];
    const records: unknown[] = [
      null,
      { type: 'event_msg', payload: { type: 'user_message', message: 'mirror' } },
      codexUser('assistant', { role: 'assistant' }),
      { type: 'response_item', payload: null },
      codexUser('   '),
      ...preambles.map(tag => codexUser(` <${tag}>\nsynthetic\n</${tag}>`)),
    ];

    // Act
    const rejected = records.flatMap(record => subject.observe(record, context()));
    const noTime = subject.observe(
      { type: 'response_item', payload: { type: 'message', role: 'user', content: 'no time' } },
      { source: '/synthetic/transcript.jsonl' },
    );
    subject.reset();

    // Assert
    should(rejected).be.empty();
    should(noTime).be.empty();
  });
});
