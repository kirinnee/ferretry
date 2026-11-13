import { describe, expect, test } from 'bun:test';
import { clockOfInstant } from '../../../src/shared/message-clock.ts';

// The owner's phone said 11:58 in Tokyo while the bubble said 01:45 — the daemon's UTC wall clock.
const UTC_0145 = Date.UTC(2026, 9, 18, 1, 45, 44);

describe('clockOfInstant', () => {
  test('prints an instant on the zone it is given, not UTC', () => {
    expect(clockOfInstant(UTC_0145, { timeZone: 'Asia/Tokyo', locale: 'en-GB' })?.short).toBe('10:45');
    expect(clockOfInstant(UTC_0145, { timeZone: 'UTC', locale: 'en-GB' })?.short).toBe('01:45');
    expect(clockOfInstant(UTC_0145, { timeZone: 'America/Los_Angeles', locale: 'en-GB' })?.short).toBe('18:45');
  });

  test('spells the tooltip out as the full local date, time to the second, and zone', () => {
    const tokyo = clockOfInstant(UTC_0145, { timeZone: 'Asia/Tokyo', locale: 'en-GB' });
    expect(tokyo?.full).toContain('18 Oct 2026');
    expect(tokyo?.full).toContain('10:45:44');
    expect(tokyo?.full).toMatch(/GMT\+9|JST/u);
    // The day moves with the zone: 01:45 UTC on the 18th is still the 17th in Los Angeles.
    expect(clockOfInstant(UTC_0145, { timeZone: 'America/Los_Angeles', locale: 'en-GB' })?.full).toContain(
      '17 Oct 2026',
    );
  });

  test('is 24-hour whatever the locale, so no row says 1:45 PM beside another saying 13:45', () => {
    const afternoon = Date.UTC(2026, 9, 18, 13, 5, 0);
    expect(clockOfInstant(afternoon, { timeZone: 'UTC', locale: 'en-US' })?.short).toBe('13:05');
    expect(clockOfInstant(Date.UTC(2026, 9, 18, 0, 5, 0), { timeZone: 'UTC', locale: 'en-US' })?.short).toBe('00:05');
  });

  test('accepts a number or an ISO string, and refuses what is not an instant', () => {
    const environment = { timeZone: 'Asia/Tokyo', locale: 'en-GB' };
    expect(clockOfInstant(new Date(UTC_0145).toISOString(), environment)).toEqual(
      clockOfInstant(UTC_0145, environment),
    );
    expect(clockOfInstant(undefined, environment)).toBeUndefined();
    expect(clockOfInstant('not a date', environment)).toBeUndefined();
  });

  test('with no environment it follows the device’s own zone', () => {
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(clockOfInstant(UTC_0145)).toEqual(clockOfInstant(UTC_0145, { timeZone: device }));
  });

  describe('with a "now", a time from another day names its day', () => {
    const environment = { timeZone: 'UTC', locale: 'en-GB' };
    const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);

    test('the same day keeps the bare clock', () => {
      expect(clockOfInstant(Date.UTC(2026, 10, 12, 8, 55, 0), { ...environment, now: NOW })?.short).toBe('08:55');
    });

    test('an earlier day adds the date, in the reader’s locale', () => {
      expect(clockOfInstant(Date.UTC(2026, 10, 8, 8, 55, 0), { ...environment, now: NOW })?.short).toBe('8 Nov, 08:55');
      expect(
        clockOfInstant(Date.UTC(2026, 10, 8, 8, 55, 0), { ...environment, locale: 'en-US', now: NOW })?.short,
      ).toBe('Nov 8, 08:55');
    });

    test('“today” is the reader’s calendar day, not UTC’s', () => {
      const tokyo = { timeZone: 'Asia/Tokyo', locale: 'en-GB', now: Date.UTC(2026, 10, 12, 16, 0, 0) };
      // 16:00Z is 01:00 on the 13th in Tokyo; 14:00Z on the 12th is 23:00 on the 12th — yesterday there.
      expect(clockOfInstant(Date.UTC(2026, 10, 12, 14, 0, 0), tokyo)?.short).toBe('12 Nov, 23:00');
      expect(clockOfInstant(Date.UTC(2026, 10, 12, 16, 0, 0), tokyo)?.short).toBe('01:00');
    });

    test('without a now nothing changes', () => {
      expect(clockOfInstant(Date.UTC(2026, 10, 8, 8, 55, 0), environment)?.short).toBe('08:55');
    });
  });
});
