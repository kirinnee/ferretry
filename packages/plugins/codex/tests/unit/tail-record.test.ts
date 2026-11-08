/** U5: a Codex rollout's events as the records the turn watch and the live readout read: kinds and counts, no text. */
import { describe, expect, test } from 'bun:test';
import { CodexTranscriptParser } from '../../daemon/lib/transcript/codex.ts';
import { tailRecordOf } from '../../daemon/lib/transcript/tail-record.ts';

const AT = '2026-11-08T10:00:00.000Z';
const parser = new CodexTranscriptParser();
const records = (...lines: unknown[]) =>
  lines.flatMap((line, index) =>
    parser.parseRecord(line, { source: 'rollout.jsonl', line: index + 1, sessionId: 's1' }).events.flatMap(event => {
      const record = tailRecordOf(event);
      return record === undefined ? [] : [record];
    }),
  );

describe('tailRecordOf', () => {
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
