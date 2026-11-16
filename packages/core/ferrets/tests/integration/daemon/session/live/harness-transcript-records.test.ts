import { describe, it } from 'bun:test';
import should from 'should';
import { eventOfRecord } from '../../../../../daemon/adapters/session/live/harness-transcript.ts';

/**
 * A tail record carries no text, so every event made of one carries none either: a sentence reaches a frame only as a
 * harness's own bounded `notice`. Each kind of record maps to its event, optional fields kept when given and left out
 * when not.
 */

describe('eventOfRecord', () => {
  it('should map a message record, keeping who typed it only when the record says', async () => {
    // Act
    const plain = eventOfRecord('claude', { kind: 'message', role: 'user' } as never);
    const typed = eventOfRecord('codex', {
      kind: 'message',
      role: 'user',
      inputSource: 'terminal',
      at: '2026-11-09T10:00:00.000Z',
    } as never);

    // Assert
    should(plain).eql({ harness: 'claude', kind: 'message', role: 'user', text: '' });
    should(typed).eql({
      harness: 'codex',
      timestamp: '2026-11-09T10:00:00.000Z',
      kind: 'message',
      role: 'user',
      text: '',
      inputSource: 'terminal',
    });
  });

  it('should map work, a turn boundary and a compaction', async () => {
    // Act
    const work = eventOfRecord('claude', { kind: 'work' } as never);
    const turn = eventOfRecord('claude', { kind: 'turn', state: 'started' } as never);
    const compacted = eventOfRecord('claude', {
      kind: 'compaction',
      trigger: 'auto',
      tokensBefore: 900,
      tokensAfter: 100,
    } as never);
    const bare = eventOfRecord('claude', { kind: 'compaction' } as never);

    // Assert
    should(work).eql({ harness: 'claude', kind: 'reasoning', role: 'assistant', text: '', format: 'thinking' });
    should(turn).eql({ harness: 'claude', kind: 'turn', role: 'system', state: 'started' });
    should(compacted).eql({
      harness: 'claude',
      kind: 'compaction',
      role: 'system',
      trigger: 'auto',
      tokensBefore: 900,
      tokensAfter: 100,
    });
    should(bare).eql({ harness: 'claude', kind: 'compaction', role: 'system' });
  });

  it('should map a usage record with every count it has, and with none', async () => {
    // Act
    const full = eventOfRecord('codex', {
      kind: 'usage',
      call: 'call-1',
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 4,
      contextTokens: 50,
    } as never);
    const bare = eventOfRecord('codex', { kind: 'usage' } as never);

    // Assert
    should(full).eql({
      harness: 'codex',
      kind: 'usage',
      role: 'system',
      messageId: 'call-1',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 4,
        contextTokens: 50,
      },
    });
    should(bare).eql({ harness: 'codex', kind: 'usage', role: 'system', usage: {} });
  });

  it('should map an error record to a non-recoverable error carrying only the harness’s own notice and code', async () => {
    // Act
    const noticed = eventOfRecord('claude', { kind: 'error', notice: 'usage limit reached', code: 'limit' } as never);
    const silent = eventOfRecord('claude', { kind: 'error' } as never);

    // Assert
    should(noticed).eql({
      harness: 'claude',
      kind: 'error',
      role: 'system',
      error: { message: 'usage limit reached', code: 'limit', recoverable: false },
    });
    should(silent).eql({
      harness: 'claude',
      kind: 'error',
      role: 'system',
      error: { message: '', recoverable: false },
    });
  });
});
