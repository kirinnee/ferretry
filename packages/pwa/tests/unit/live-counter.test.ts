import { describe, expect, test } from 'bun:test';
import type { SessionLiveActivity } from '@ferretry/protocol';
import {
  COUNT_UP_MS,
  countUpValue,
  formatElapsedSeconds,
  formatTokenCount,
  instantMs,
  liveReadout,
  msToNextSecond,
  wholeSecondsSince,
} from '../../src/lib/live-counter.ts';
import type { PaneActivity } from '../../src/lib/pane-activity.ts';

const TURN = '2026-10-18T07:00:00.000Z';
const OTHER_TURN = '2026-10-18T06:00:00.000Z';

const sample = (overrides: Partial<SessionLiveActivity> = {}): SessionLiveActivity => ({
  sessionId: 's1',
  at: '2026-10-18T07:00:05.000Z',
  turnStartedAt: TURN,
  ...overrides,
});

const pane = (overrides: Partial<PaneActivity> = {}): PaneActivity => ({
  harness: 'claude',
  verb: 'Pontificating…',
  ...overrides,
});

describe('msToNextSecond', () => {
  test('is the time left until the elapsed time next crosses a whole second', () => {
    expect(msToNextSecond(0, 1_400)).toBe(600);
    expect(msToNextSecond(0, 1_999)).toBe(1);
    expect(msToNextSecond(250, 1_250)).toBe(1_000);
  });

  test('a full second away exactly on a boundary, never zero', () => {
    expect(msToNextSecond(0, 0)).toBe(1_000);
    expect(msToNextSecond(0, 3_000)).toBe(1_000);
  });

  test('a start still in the future waits for it, capped at a second', () => {
    expect(msToNextSecond(10_300, 10_000)).toBe(300);
    expect(msToNextSecond(60_000, 10_000)).toBe(1_000);
  });
});

describe('wholeSecondsSince', () => {
  test('floors to whole seconds and never reads negative', () => {
    expect(wholeSecondsSince(0, 999)).toBe(0);
    expect(wholeSecondsSince(0, 1_000)).toBe(1);
    expect(wholeSecondsSince(0, 41_999)).toBe(41);
    expect(wholeSecondsSince(5_000, 1_000)).toBe(0);
  });
});

describe('instantMs', () => {
  test('reads an ISO instant, and nothing else as an instant', () => {
    expect(instantMs('1970-01-01T00:00:01.500Z')).toBe(1_500);
    expect(instantMs(undefined)).toBeNull();
    expect(instantMs(null)).toBeNull();
    expect(instantMs('yesterday-ish')).toBeNull();
  });
});

describe('countUpValue', () => {
  test('starts at the old value, lands exactly on the target, and is strictly between in the middle', () => {
    expect(countUpValue(1_000, 2_000, 0)).toBe(1_000);
    const middle = countUpValue(1_000, 2_000, COUNT_UP_MS / 2);
    expect(middle).toBeGreaterThan(1_000);
    expect(middle).toBeLessThan(2_000);
    expect(countUpValue(1_000, 2_000, COUNT_UP_MS)).toBe(2_000);
    expect(countUpValue(1_000, 2_000, COUNT_UP_MS * 10)).toBe(2_000);
  });

  test('only ever rises as the time passes', () => {
    let previous = 0;
    for (let elapsed = 0; elapsed <= COUNT_UP_MS; elapsed += 8) {
      const value = countUpValue(0, 500, elapsed);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  test('a lower or equal target holds the shown value instead of counting down', () => {
    expect(countUpValue(900, 400, 50)).toBe(900);
    expect(countUpValue(900, 900, 50)).toBe(900);
  });

  test('a negative elapsed time reads as the start; a zero duration jumps to the target', () => {
    expect(countUpValue(10, 20, -50)).toBe(10);
    expect(countUpValue(10, 20, 50, 0)).toBe(20);
  });
});

describe('formatTokenCount', () => {
  test('prints counts the way the harness does', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(980)).toBe('980');
    expect(formatTokenCount(3_149)).toBe('3.1k');
    expect(formatTokenCount(9_999)).toBe('9.9k');
    expect(formatTokenCount(12_400)).toBe('12k');
    expect(formatTokenCount(999_999)).toBe('999k');
    expect(formatTokenCount(1_250_000)).toBe('1.2M');
    expect(formatTokenCount(-5)).toBe('0');
  });
});

describe('formatElapsedSeconds', () => {
  test('prints seconds, minutes and hours', () => {
    expect(formatElapsedSeconds(0)).toBe('0s');
    expect(formatElapsedSeconds(42.9)).toBe('42s');
    expect(formatElapsedSeconds(345)).toBe('5m 45s');
    expect(formatElapsedSeconds(3_720)).toBe('1h 02m');
    expect(formatElapsedSeconds(-3)).toBe('0s');
  });
});

describe('liveReadout', () => {
  test('a turn with no start has no clock and no sample, whatever was sampled', () => {
    const readout = liveReadout({ turnStartedAt: null, live: sample({ outputTokens: 50 }), pane: null });
    expect(readout).toEqual({ startedAt: null, verb: null, outputTokens: null, inputTokens: null });
  });

  test('an unreadable start is no start', () => {
    expect(liveReadout({ turnStartedAt: 'garbled', live: null, pane: null }).startedAt).toBeNull();
  });

  test('takes the clock, counts and verb from the sample of this turn', () => {
    const readout = liveReadout({
      turnStartedAt: TURN,
      live: sample({ outputTokens: 3_100, inputTokens: 48_000, verb: 'Cogitating…' }),
      pane: null,
    });
    expect(readout).toEqual({
      startedAt: Date.parse(TURN),
      verb: 'Cogitating…',
      outputTokens: 3_100,
      inputTokens: 48_000,
    });
  });

  test('ignores a sample that belongs to another turn, so last turn’s totals never leak', () => {
    const readout = liveReadout({
      turnStartedAt: TURN,
      live: sample({ turnStartedAt: OTHER_TURN, outputTokens: 9_000, inputTokens: 90_000, verb: 'Stale…' }),
      pane: null,
    });
    expect(readout.outputTokens).toBeNull();
    expect(readout.inputTokens).toBeNull();
    expect(readout.verb).toBeNull();
  });

  test('ignores a sample that names no turn', () => {
    const { turnStartedAt: _dropped, ...unscoped } = sample({ outputTokens: 70 });
    expect(liveReadout({ turnStartedAt: TURN, live: unscoped, pane: null }).outputTokens).toBeNull();
  });

  test('takes the larger of the pane counter and the sample, whichever is ahead', () => {
    const ahead = (paneTokens: string, sampled: number) =>
      liveReadout({
        turnStartedAt: TURN,
        live: sample({ outputTokens: sampled }),
        pane: pane({ tokens: paneTokens }),
      }).outputTokens;
    expect(ahead('↓ 3.1k tokens', 2_000)).toBe(3_100);
    expect(ahead('↓ 1.5k tokens', 2_000)).toBe(2_000);
    expect(ahead('↓ 1,200 tokens', 800)).toBe(1_200);
    expect(ahead('↓ 2M tokens', 800)).toBe(2_000_000);
  });

  test('reads the pane alone when there is no sample, and the sample alone when the pane printed no counter', () => {
    expect(liveReadout({ turnStartedAt: TURN, live: null, pane: pane({ tokens: '↓ 410 tokens' }) }).outputTokens).toBe(
      410,
    );
    expect(liveReadout({ turnStartedAt: TURN, live: sample({ outputTokens: 12 }), pane: pane() }).outputTokens).toBe(
      12,
    );
    expect(liveReadout({ turnStartedAt: TURN, live: null, pane: pane() }).outputTokens).toBeNull();
  });

  test('ignores an ↑ pane counter, which is what is being sent rather than written', () => {
    const readout = liveReadout({
      turnStartedAt: TURN,
      live: sample({ outputTokens: 700 }),
      pane: pane({ tokens: '↑ 99k tokens' }),
    });
    expect(readout.outputTokens).toBe(700);
  });

  test('ignores a pane counter that is not a number of tokens', () => {
    for (const tokens of ['thinking', '. tokens', '1.2.3 tokens']) {
      expect(liveReadout({ turnStartedAt: TURN, live: null, pane: pane({ tokens }) }).outputTokens).toBeNull();
    }
  });

  test('the pane names the verb in preference to the sample', () => {
    expect(liveReadout({ turnStartedAt: TURN, live: sample({ verb: 'From sample…' }), pane: pane() }).verb).toBe(
      'Pontificating…',
    );
  });
});
