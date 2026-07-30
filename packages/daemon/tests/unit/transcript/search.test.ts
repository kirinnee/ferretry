import { describe, it } from 'bun:test';
import should from 'should';
import { searchTranscript } from '../../../src/lib/transcript/search.ts';
import type { TranscriptEvent } from '../../../src/lib/transcript/types.ts';

const events: readonly TranscriptEvent[] = [
  { harness: 'claude', role: 'system', kind: 'turn', state: 'started' },
  { harness: 'claude', role: 'user', kind: 'message', text: 'Please fix the login bug.', timestamp: 't1' },
  { harness: 'claude', role: 'assistant', kind: 'reasoning', text: 'Inspecting LOGIN state.', format: 'thinking' },
  {
    harness: 'claude',
    role: 'assistant',
    kind: 'tool-call',
    call: {
      id: 'tool-1',
      name: 'AskUserQuestion',
      input: {},
      questions: [{ question: 'Which login path?', options: [], multiple: false }],
    },
  },
  { harness: 'claude', role: 'system', kind: 'turn', state: 'started' },
  {
    harness: 'claude',
    role: 'tool',
    kind: 'tool-result',
    result: { callId: 'tool-1', content: 'login repaired', text: 'login repaired', isError: false },
  },
  {
    harness: 'claude',
    role: 'system',
    kind: 'error',
    error: { message: 'Login retry failed.', recoverable: true },
  },
];

describe('searchTranscript', () => {
  it('should search typed text fields case-insensitively and retain turn metadata', () => {
    // Act
    const actual = searchTranscript(events, 'LOGIN', { limit: 10 });

    // Assert
    should(actual).have.length(5);
    should(actual.map(match => match.kind)).deepEqual(['message', 'reasoning', 'tool-call', 'tool-result', 'error']);
    should(actual[0]).containDeep({ turn: 1, role: 'user', timestamp: 't1' });
    should(actual.at(-1)).containDeep({ turn: 2, role: 'system' });
  });

  it('should honor role filters, case sensitivity, and non-positive limits', () => {
    // Act
    const assistantOnly = searchTranscript(events, 'login', { roles: ['assistant'], limit: 10 });
    const caseSensitive = searchTranscript(events, 'LOGIN', { caseSensitive: true, limit: 10 });

    // Assert
    should(assistantOnly.map(match => match.kind)).deepEqual(['reasoning', 'tool-call']);
    should(caseSensitive.map(match => match.kind)).deepEqual(['reasoning']);
    should(searchTranscript(events, 'login', { limit: 0 })).deepEqual([]);
    should(searchTranscript(events, 'login', { limit: -3 })).deepEqual([]);
    should(searchTranscript(events, '   ')).deepEqual([]);
  });

  it('should add ellipses when a normalized snippet is truncated', () => {
    // Arrange
    const input: readonly TranscriptEvent[] = [
      {
        harness: 'codex',
        role: 'assistant',
        kind: 'message',
        text: `${'x'.repeat(200)}\nneedle\t${'y'.repeat(200)}`,
      },
    ];

    // Act
    const actual = searchTranscript(input, 'needle');

    // Assert
    should(actual[0]?.snippet).startWith('… ');
    should(actual[0]?.snippet).endWith(' …');
    should(actual[0]?.snippet).containEql('needle');
    should(actual[0]?.snippet).not.containEql('\n');
  });

  it('should search each explicit attachment shape and skip non-text events', () => {
    // Arrange
    const input: readonly TranscriptEvent[] = [
      {
        harness: 'claude',
        role: 'user',
        kind: 'attachment',
        attachment: { kind: 'queued-command', text: 'needle queued', origin: 'human' },
      },
      {
        harness: 'claude',
        role: 'system',
        kind: 'attachment',
        attachment: { kind: 'remote-control', url: 'https://example.invalid/needle' },
      },
      {
        harness: 'claude',
        role: 'user',
        kind: 'attachment',
        attachment: { kind: 'document', text: 'needle document' },
      },
      {
        harness: 'codex',
        role: 'user',
        kind: 'attachment',
        attachment: { kind: 'image', name: 'needle.png' },
      },
      {
        harness: 'codex',
        role: 'user',
        kind: 'attachment',
        attachment: { kind: 'file', uri: 'fixture://needle' },
      },
      { harness: 'codex', role: 'system', kind: 'settings', settings: { model: 'needle-model' } },
      { harness: 'codex', role: 'system', kind: 'turn', state: 'completed' },
      { harness: 'codex', role: 'system', kind: 'usage', usage: { model: 'needle-model' } },
    ];

    // Act
    const actual = searchTranscript(input, 'needle', { limit: 20 });

    // Assert
    should(actual.map(match => match.kind)).deepEqual([
      'attachment',
      'attachment',
      'attachment',
      'attachment',
      'attachment',
    ]);
  });
});
