import { describe, expect, test } from 'bun:test';
import { clockOfInstant } from '../../src/lib/message-clock.ts';

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
});
