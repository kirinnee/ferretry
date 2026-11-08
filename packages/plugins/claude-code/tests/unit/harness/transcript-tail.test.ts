/** U5: the records the turn watch and the live readout read from the END of a Claude transcript: kinds and counts, no text. */
import { describe, expect, test } from 'bun:test';
import { parseTail, windowHoldsOneCutRecord } from '../../../daemon/lib/harness/transcript.ts';
import type { Instant } from '@ferretry/std';

const AT = (n: number): Instant => `2026-11-08T10:00:${String(n).padStart(2, '0')}.000Z` as Instant;
const line = (value: unknown): string => JSON.stringify(value);

const user = (n: number, content: unknown, extra: object = {}) =>
  line({ type: 'user', uuid: `u${n}`, timestamp: AT(n), message: { role: 'user', content }, ...extra });
const assistant = (n: number, content: unknown, extra: object = {}, usage: object | undefined = undefined) =>
  line({
    type: 'assistant',
    uuid: `a${n}`,
    timestamp: AT(n),
    message: { id: `m${n}`, role: 'assistant', content, ...(usage === undefined ? {} : { usage }), ...extra },
  });

describe('parseTail', () => {
  test('a person message, a tool round and a finished reply read as message, work and an ended turn', () => {
    const records = parseTail(
      [
        user(1, 'SECRET-PROMPT please fix it'),
        assistant(2, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'SECRET-COMMAND' } }], {
          stop_reason: 'tool_use',
        }),
        user(3, [{ type: 'tool_result', tool_use_id: 't1', content: 'SECRET-OUTPUT' }]),
        assistant(
          4,
          [{ type: 'text', text: 'SECRET-REPLY' }],
          { stop_reason: 'end_turn' },
          { input_tokens: 5, output_tokens: 7 },
        ),
      ].join('\n'),
      false,
    );
    expect(records.map(record => record.kind)).toEqual(['message', 'work', 'work', 'message', 'usage', 'turn']);
    expect(records[0]).toEqual({ kind: 'message', role: 'user', at: AT(1) });
    expect(records.at(-1)).toEqual({ kind: 'turn', state: 'completed', at: AT(4) });
    // G161: nothing a person or the agent wrote is carried.
    expect(JSON.stringify(records)).not.toContain('SECRET');
  });

  test('one call counted once: every record of a reply names its call, and its tokens are the call’s own', () => {
    const records = parseTail(
      [
        assistant(
          1,
          [{ type: 'thinking', thinking: 'x' }],
          {},
          { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
        ),
      ].join('\n'),
      false,
    );
    expect(records.find(record => record.kind === 'usage')).toEqual({
      kind: 'usage',
      at: AT(1),
      call: 'm1',
      inputTokens: 10,
      outputTokens: 3,
      cachedInputTokens: 100,
      cacheCreationInputTokens: 20,
      contextTokens: 130,
    });
  });

  test('a compaction boundary carries its trigger and the context it began from', () => {
    const records = parseTail(
      line({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: AT(9),
        compactMetadata: { trigger: 'auto', preTokens: 150000 },
      }),
      false,
    );
    expect(records).toEqual([{ kind: 'compaction', at: AT(9), trigger: 'auto', tokensBefore: 150000 }]);
  });

  test('G161 a compaction boundary carries the context it ended with, so the freed tokens are known', () => {
    const records = parseTail(
      line({
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: AT(9),
        compactMetadata: { trigger: 'manual', preTokens: 150000, postTokens: 20000 },
      }),
      false,
    );
    expect(records).toEqual([
      { kind: 'compaction', at: AT(9), trigger: 'manual', tokensBefore: 150000, tokensAfter: 20000 },
    ]);
  });

  test('a user record the harness wrote (origin not human, shown only in the transcript view) is marked, a human one is not', () => {
    const records = parseTail(
      [
        user(1, 'hello', { origin: { kind: 'human' } }),
        user(2, 'task done', { origin: { kind: 'task-notification' } }),
        user(3, 'shown only', { isVisibleInTranscriptOnly: true }),
      ].join('\n'),
      false,
    );
    expect(records).toEqual([
      { kind: 'message', role: 'user', at: AT(1) },
      { kind: 'message', role: 'user', at: AT(2), inputSource: 'harness' },
      { kind: 'message', role: 'user', at: AT(3), inputSource: 'harness' },
    ]);
  });

  test('a window that holds nothing but the end of one record is told apart from one that holds whole lines', () => {
    expect(windowHoldsOneCutRecord('{"type":"user","uuid":"x","timest')).toBe(true);
    expect(windowHoldsOneCutRecord('ngs"}\n')).toBe(true);
    expect(windowHoldsOneCutRecord(`ngs"}\n${user(2, 'x')}\n`)).toBe(false);
    expect(windowHoldsOneCutRecord('ngs"}\n{"type":"summary"')).toBe(false);
  });

  test('text the harness wrote into the user channel is marked, and a window cut mid-record skips its first line', () => {
    const cut = parseTail(
      `{"type":"user","uuid":"x","timest\n${user(2, 'CONTINUED', { isCompactSummary: true })}\nnot json`,
      true,
    );
    expect(cut).toEqual([{ kind: 'message', role: 'user', at: AT(2), inputSource: 'harness' }]);
    expect(parseTail('{"type":"user","uuid":"x","timest', false)).toEqual([]);
  });
});
