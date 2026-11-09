/** U5: a Codex rollout's events as the records the turn watch and the live readout read: kinds and counts, no text. */
import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import { CodexTranscriptParser } from '../../daemon/lib/transcript/codex.ts';
import { tailRecordOf } from '../../daemon/lib/transcript/tail-record.ts';

const AT = '2026-11-08T10:00:00.000Z';
const parser = new CodexTranscriptParser();
const records = (...lines: unknown[]) =>
  lines.flatMap((line, index) =>
    parser.parseRecord(line, { source: 'rollout.jsonl', line: index + 1, sessionId: 's1' }).events.flatMap(event => {
      const record = tailRecordOf(event, text => text);
      return record === undefined ? [] : [record];
    }),
  );

describe('tailRecordOf', () => {
  test('G161 a vault value that crosses the 200-character cut is masked whole BEFORE the notice is cut, so no prefix survives', () => {
    const secret = `sk-live-${'q'.repeat(60)}`;
    const message = `${'a'.repeat(170)} ${secret} tail`;
    const [event] = parser
      .parseRecord(
        {
          timestamp: AT,
          type: 'event_msg',
          payload: { type: 'task_complete', error: { message, codex_error_info: 'usage_limit_exceeded' } },
        },
        { source: 'rollout.jsonl', line: 1, sessionId: 's1' },
      )
      .events.filter(each => each.kind === 'error');
    if (event === undefined) throw new Error('the failure is an error event');
    const record = tailRecordOf(event, text => text.replaceAll(secret, '*'.repeat(secret.length)));
    const notice = record?.kind === 'error' ? (record.notice ?? '') : '';
    expect(notice.length).toBeGreaterThan(0);
    expect(notice.length).toBeLessThanOrEqual(200);
    expect(notice).not.toContain('sk-');
  });

  test('a turn boundary and a usage-limit failure keep their kind, code and short notice, and nothing else is said', () => {
    const tail = records(
      { timestamp: AT, type: 'event_msg', payload: { type: 'task_started' } },
      {
        timestamp: AT,
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          error: { message: 'You hit your usage limit.\nSECRET second line', codex_error_info: 'usage_limit_exceeded' },
        },
      },
    );
    expect(tail.map(record => record.kind)).toEqual(['turn', 'turn', 'error']);
    const error = tail.find(record => record.kind === 'error');
    expect(error).toMatchObject({ code: 'usage_limit_exceeded', notice: 'You hit your usage limit.' });
    expect(JSON.stringify(tail)).not.toContain('SECRET');
  });
});

describe('tailRecordOf over events of every kind', () => {
  const base = { harness: 'codex' as const, timestamp: AT };
  const INSTANT = AT as Instant;
  const tailOf = (event: Parameters<typeof tailRecordOf>[0]) => tailRecordOf(event, text => text);

  test('a message keeps its role and where it came from, and a tool’s message is a system one', () => {
    expect(tailOf({ ...base, kind: 'message', role: 'user', text: 'hi', inputSource: 'native-queue' })).toEqual({
      kind: 'message',
      role: 'user',
      at: INSTANT,
      inputSource: 'native-queue',
    });
    expect(tailOf({ ...base, kind: 'message', role: 'tool', text: 'out' })).toEqual({
      kind: 'message',
      role: 'system',
      at: INSTANT,
    });
  });

  test('work is reasoning, a tool call or a tool result, with no text, and an event without a time carries none', () => {
    const { timestamp: _unused, ...untimed } = base;
    expect(
      tailOf({ ...untimed, role: 'assistant', kind: 'reasoning', text: 'secret thoughts', format: 'reasoning' }),
    ).toEqual({
      kind: 'work',
    });
    expect(tailOf({ ...base, role: 'assistant', kind: 'tool-call', call: { id: 'c', name: 'n', input: {} } })).toEqual({
      kind: 'work',
      at: INSTANT,
    });
    expect(
      tailOf({ ...base, role: 'tool', kind: 'tool-result', result: { callId: 'c', content: null, isError: false } }),
    ).toEqual({ kind: 'work', at: INSTANT });
  });

  test('a usage record keeps every count it has, the call it belongs to, and nothing it does not have', () => {
    expect(
      tailOf({
        ...base,
        role: 'system',
        kind: 'usage',
        messageId: 'm1',
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cachedInputTokens: 6,
          cacheCreationInputTokens: 1,
          contextTokens: 12,
        },
      }),
    ).toEqual({
      kind: 'usage',
      at: INSTANT,
      call: 'm1',
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 6,
      cacheCreationInputTokens: 1,
      contextTokens: 12,
    });
    expect(tailOf({ ...base, role: 'system', kind: 'usage', usage: {} })).toEqual({ kind: 'usage', at: INSTANT });
  });

  test('a compaction keeps its trigger and its counts when the harness stated them', () => {
    expect(
      tailOf({
        ...base,
        role: 'system',
        kind: 'compaction',
        trigger: 'auto',
        tokensBefore: 90_000,
        tokensAfter: 4_000,
      }),
    ).toEqual({ kind: 'compaction', at: INSTANT, trigger: 'auto', tokensBefore: 90_000, tokensAfter: 4_000 });
    expect(tailOf({ ...base, role: 'system', kind: 'compaction' })).toEqual({ kind: 'compaction', at: INSTANT });
  });

  test('an error with no words has no notice, and what says nothing about a turn is dropped', () => {
    expect(tailOf({ ...base, role: 'system', kind: 'error', error: { message: '   ', recoverable: true } })).toEqual({
      kind: 'error',
      at: INSTANT,
    });
    expect(tailOf({ ...base, role: 'system', kind: 'settings', settings: { model: 'gpt-6.1-sol' } })).toBeUndefined();
    expect(
      tailOf({ ...base, role: 'user', kind: 'attachment', attachment: { kind: 'image', data: 'QUJD' } }),
    ).toBeUndefined();
  });
});
