/**
 * The passive Codex reading of a rollout (§8.2.3), over in-memory bytes: the newest `token_count` event's `rate_limits`,
 * found from the END of the file one window at a time. Ported from v4's rollout-rate-limits test.
 */
import { describe, expect, test } from 'bun:test';
import {
  newestRateLimitsInText,
  newestRolloutReading,
  ROLLOUT_FIRST_WINDOW_BYTES,
  ROLLOUT_MAX_RECORD_BYTES,
  type RolloutBytes,
} from '../../../daemon/lib/credentials/rollout-reading.ts';

const tokenCount = (timestamp: string, rateLimits: unknown): string =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', info: null, rate_limits: rateLimits },
  });

const limits = (primary: number, secondary: number) => ({
  primary: { used_percent: primary, window_minutes: 300, resets_at: 1_800_003_600 },
  secondary: { used_percent: secondary, window_minutes: 10_080, resets_at: 1_800_500_000 },
});

const at = (iso: string): number => Date.parse(iso);

const encoder = new TextEncoder();
const filler = (records: number): string =>
  `${JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1_000) } })}\n`.repeat(records);

/** A rollout held in memory, counting the windows it is asked for. */
function rollout(text: string, mtimeMs = 1_700_000_000_000): RolloutBytes & { readonly reads: number[] } {
  const bytes = encoder.encode(text);
  const reads: number[] = [];
  return {
    size: bytes.byteLength,
    mtimeMs,
    reads,
    read: async (offset, length) => {
      reads.push(length);
      return bytes.slice(offset, offset + length);
    },
  };
}

describe('newestRateLimitsInText', () => {
  test('takes the LAST token_count event that measured something', () => {
    const text = [
      tokenCount('2026-10-13T07:00:00.000Z', limits(10, 1)),
      '{"type":"response_item","payload":{"type":"message"}}',
      tokenCount('2026-10-13T07:05:00.000Z', limits(20, 2)),
      tokenCount('2026-10-13T07:06:00.000Z', null),
      'not json token_count rate_limits',
      JSON.stringify({ type: 'event_msg', payload: { type: 'other', note: 'token_count rate_limits' } }),
      '',
    ].join('\n');

    expect(newestRateLimitsInText(text)).toEqual({
      version: 1,
      source: 'codex-rollout',
      at: at('2026-10-13T07:05:00.000Z'),
      fiveHour: { usedPercent: 20, resetAt: 1_800_003_600_000 },
      weekly: { usedPercent: 2, resetAt: 1_800_500_000_000 },
    });
  });

  test('reads an older rollout reset given relative to the event, from the event’s own timestamp', () => {
    const relative = JSON.stringify({
      timestamp: '2023-11-14T22:13:20.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: 55, resets_in_seconds: 60 } } },
    });

    expect(newestRateLimitsInText(relative)).toEqual({
      version: 1,
      source: 'codex-rollout',
      at: 1_700_000_000_000,
      fiveHour: { usedPercent: 55, resetAt: 1_700_000_060_000 },
    });
  });

  test('passes over a record that is JSON but not an object', () => {
    const text = [
      tokenCount('2026-10-13T07:05:00.000Z', limits(20, 2)),
      JSON.stringify('token_count rate_limits'),
      JSON.stringify(['token_count', 'rate_limits']),
      'null',
      '',
    ].join('\n');

    expect(newestRateLimitsInText(text)?.fiveHour?.usedPercent).toBe(20);
  });

  test('passes over an event with no timestamp or one that is no instant, and takes the older stamped one', () => {
    const event = (stamp: Record<string, unknown>, used: number) =>
      JSON.stringify({ ...stamp, type: 'event_msg', payload: { type: 'token_count', rate_limits: limits(used, 1) } });
    const text = [
      event({ timestamp: '2026-10-13T07:00:00.000Z' }, 10),
      event({ timestamp: 'yesterday' }, 20),
      event({ timestamp: -5 }, 30),
      event({ timestamp: '1969-12-31T23:59:59.000Z' }, 35),
      event({}, 40),
    ].join('\n');

    expect(newestRateLimitsInText(text)?.fiveHour?.usedPercent).toBe(10);
    expect(newestRateLimitsInText([event({}, 40), event({ timestamp: 'yesterday' }, 50)].join('\n'))).toBeUndefined();
  });

  test('finds nothing in a rollout with no usable reading', () => {
    expect(newestRateLimitsInText(tokenCount('2026-10-13T07:00:00.000Z', { primary: {} }))).toBeUndefined();
    expect(newestRateLimitsInText('')).toBeUndefined();
  });

  test('records only the window the event measured', () => {
    const weeklyOnly = tokenCount('2026-10-13T07:00:00.000Z', {
      secondary: { used_percent: 8, resets_at: 1_800_500_000 },
    });

    const reading = newestRateLimitsInText(weeklyOnly);

    expect(reading?.fiveHour).toBeUndefined();
    expect(reading?.weekly?.usedPercent).toBe(8);
  });
});

describe('newestRolloutReading', () => {
  test('answers from the first window when the newest reading is near the end, reading nothing more', async () => {
    const file = rollout(`${tokenCount('2026-10-13T07:05:00.000Z', limits(30, 3))}\n`);

    const reading = await newestRolloutReading(file);

    expect(reading?.fiveHour?.usedPercent).toBe(30);
    expect(file.reads).toHaveLength(1);
  });

  test('finds the newest reading at the end of a large rollout, and one only its start holds', async () => {
    const atEnd = rollout(
      `${tokenCount('2026-10-13T07:00:00.000Z', limits(10, 1))}\n${filler(5_000)}${tokenCount('2026-10-13T08:00:00.000Z', limits(55, 5))}\n`,
    );
    const atStart = rollout(`${tokenCount('2026-10-13T06:00:00.000Z', limits(42, 4))}\n${filler(5_000)}`);

    expect((await newestRolloutReading(atEnd))?.fiveHour?.usedPercent).toBe(55);
    expect((await newestRolloutReading(atStart))?.fiveHour?.usedPercent).toBe(42);
    expect(atEnd.reads).toHaveLength(1);
    expect(atStart.reads.length).toBeGreaterThan(1);
  });

  test('finds a reading whose record straddles the boundary between two scanned windows', async () => {
    // The reading ends a few bytes past where the first window from the end begins, so the first window holds only the
    // end of it: that end is carried into the next window and joined, never lost between the two.
    const reading = `${tokenCount('2026-10-13T09:00:00.000Z', limits(77, 7))}\n`;
    const tail = `${JSON.stringify({ type: 'response_item', payload: { text: 'y'.repeat(ROLLOUT_FIRST_WINDOW_BYTES - 80) } })}\n`;
    const file = rollout(`${filler(3_000)}${reading}${tail}`);

    const found = await newestRolloutReading(file);

    expect(encoder.encode(tail).byteLength).toBeLessThan(ROLLOUT_FIRST_WINDOW_BYTES);
    expect(encoder.encode(reading + tail).byteLength).toBeGreaterThan(ROLLOUT_FIRST_WINDOW_BYTES);
    expect(found?.fiveHour?.usedPercent).toBe(77);
  });

  test('scans past one record longer than a whole window to the reading before it', async () => {
    const giant = `${JSON.stringify({ type: 'response_item', payload: { text: 'z'.repeat(3 * 1024 * 1024) } })}\n`;
    const file = rollout(`${tokenCount('2026-10-13T05:00:00.000Z', limits(64, 6))}\n${giant}`);

    expect((await newestRolloutReading(file))?.fiveHour?.usedPercent).toBe(64);
  });

  test('drops a record longer than any event can be instead of carrying it without bound', async () => {
    const huge = `${JSON.stringify({ type: 'response_item', payload: { text: 'z'.repeat(ROLLOUT_MAX_RECORD_BYTES) } })}\n`;
    const file = rollout(`${tokenCount('2026-10-13T05:00:00.000Z', limits(64, 6))}\n${huge}`);

    // The reading sits before a record too long to hold, so it is the record after the cut that decides: it is found.
    expect((await newestRolloutReading(file))?.fiveHour?.usedPercent).toBe(64);
  });

  test('keeps nothing but the normalized rate_limits fields and timestamps of what it read (the G162 trusted-consumer reason)', async () => {
    const secret = 'sk-secret-message-text';
    const noisy = JSON.stringify({
      timestamp: '2026-10-13T08:00:00.000Z',
      type: 'event_msg',
      session: { cwd: '/home/someone/private', text: secret },
      payload: {
        type: 'token_count',
        message: secret,
        info: { total_token_usage: { input_tokens: 12_345 }, text: secret },
        rate_limits: {
          plan_type: secret,
          credits: { balance: secret },
          primary: { used_percent: 44, window_minutes: 300, resets_at: 1_800_003_600, note: secret },
          secondary: { used_percent: 7, window_minutes: 10_080, resets_at: 1_800_500_000, note: secret },
        },
      },
    });
    const prose = JSON.stringify({ type: 'response_item', payload: { text: secret } });

    const found = await newestRolloutReading(rollout(`${prose}\n${noisy}\n${prose}\n`));

    expect(found).toBeDefined();
    expect(Object.keys(found ?? {}).sort()).toEqual(['at', 'fiveHour', 'source', 'version', 'weekly']);
    expect(Object.keys(found?.fiveHour ?? {}).sort()).toEqual(['resetAt', 'usedPercent']);
    expect(Object.keys(found?.weekly ?? {}).sort()).toEqual(['resetAt', 'usedPercent']);
    expect(JSON.stringify(found)).not.toContain(secret);
    expect(JSON.stringify(found)).not.toContain('/home/someone');
    expect(found?.at).toBe(at('2026-10-13T08:00:00.000Z'));
  });

  test('answers nothing for a rollout that never measured, and for an empty one', async () => {
    expect(await newestRolloutReading(rollout('{"type":"session_meta"}\n'))).toBeUndefined();
    expect(await newestRolloutReading(rollout(''))).toBeUndefined();
  });
});
