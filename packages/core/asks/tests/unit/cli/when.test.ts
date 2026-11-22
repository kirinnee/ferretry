import { describe, expect, test } from 'bun:test';
import { parseNeededBy } from '../../../cli/lib/when.ts';

/** A fixed instant: 2026-11-04 12:00 local time, whatever zone the test runs in. */
const NOW = new Date(2026, 10, 4, 12, 0, 0, 0).getTime();

describe('parseNeededBy reads the time a person typed for --by', () => {
  test('a wait adds every part to now: "in 1h 30m" is ninety minutes ahead, in any letter case', () => {
    expect(parseNeededBy('in 1h 30m', NOW)).toBe(new Date(NOW + 5_400_000).toISOString());
    expect(parseNeededBy('IN 2D', NOW)).toBe(new Date(NOW + 172_800_000).toISOString());
    expect(parseNeededBy('  in 1w ', NOW)).toBe(new Date(NOW + 604_800_000).toISOString());
  });

  test('a wait of nothing is refused, not read as "now"', () => {
    expect(() => parseNeededBy('in 0m', NOW)).toThrow('--by "in 0m" is not a time: use an ISO time');
  });

  test('a clock time still ahead today is today, with or without "at"', () => {
    expect(parseNeededBy('17:00', NOW)).toBe(new Date(2026, 10, 4, 17, 0, 0, 0).toISOString());
    expect(parseNeededBy('at 9:05', NOW - 4 * 3_600_000)).toBe(new Date(2026, 10, 4, 9, 5, 0, 0).toISOString());
  });

  test('a clock time already past (or exactly now) is tomorrow’s', () => {
    expect(parseNeededBy('09:30', NOW)).toBe(new Date(2026, 10, 5, 9, 30, 0, 0).toISOString());
    expect(parseNeededBy('12:00', NOW)).toBe(new Date(2026, 10, 5, 12, 0, 0, 0).toISOString());
  });

  test('an ISO time with an offset is that instant; one without is local; a space may stand for the T', () => {
    expect(parseNeededBy('2026-10-29T17:00:00Z', NOW)).toBe('2026-10-29T17:00:00.000Z');
    expect(parseNeededBy('2026-10-29T17:00:00+02:00', NOW)).toBe('2026-10-29T15:00:00.000Z');
    expect(parseNeededBy('2026-10-29 17:00', NOW)).toBe(new Date(2026, 9, 29, 17, 0, 0, 0).toISOString());
  });

  test('anything else, and an ISO-shaped date that is not a date, is refused naming the flag and the forms', () => {
    expect(() => parseNeededBy('tomorrow', NOW)).toThrow('--by "tomorrow" is not a time: use an ISO time');
    expect(() => parseNeededBy('2026-13-45', NOW, '--needed-by')).toThrow('--needed-by "2026-13-45" is not a time');
    expect(() => parseNeededBy('25:00', NOW)).toThrow('is not a time');
  });
});
