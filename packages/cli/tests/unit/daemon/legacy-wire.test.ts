import { describe, it } from 'bun:test';
import type { HealthView, LegacyWireUse } from '@ferretry/protocol';
import should from 'should';
import { legacyWireLines, legacyWireReport } from '../../../src/lib/daemon/legacy-wire';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const at = (ms: number): string => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const use = (route: string, lastAgoMs: number, lastClientVersion?: string): LegacyWireUse => ({
  route,
  firstAt: at(30 * DAY),
  lastAt: at(lastAgoMs),
  count: 3,
  ...(lastClientVersion === undefined ? {} : { lastClientVersion }),
});

describe('legacy wire lines', () => {
  it('should print nothing for a daemon that sends no legacyWire field', () => {
    // Act + Assert
    should(legacyWireLines(undefined, NOW)).deepEqual([]);
  });

  it('should print one ok line when the daemon reports no uses', () => {
    // Act + Assert
    should(legacyWireLines([], NOW)).deepEqual(['no older clients seen for 14 days']);
  });

  it('should print one ok line when every entry is older than 14 days', () => {
    // Act
    const actual = legacyWireLines([use('POST /v1/a', 15 * DAY), use('GET /v1/b', 90 * DAY, '4.1.0')], NOW);

    // Assert
    should(actual).deepEqual(['no older clients seen for 14 days']);
  });

  it.each([
    ['seconds', 30_000, 'under a minute'],
    ['one minute', MINUTE, '1 minute'],
    ['minutes', 59 * MINUTE, '59 minutes'],
    ['one hour', HOUR, '1 hour'],
    ['hours', 5 * HOUR, '5 hours'],
    ['one day', DAY, '1 day'],
    ['days', 3 * DAY, '3 days'],
    ['the edge of the window', 14 * DAY, '14 days'],
    ['the future (clock skew)', -HOUR, 'under a minute'],
  ])('should name a use %s ago, with the client version', (_name, ageMs, said) => {
    // Act
    const actual = legacyWireLines([use('GET /v1/sessions/*/attention', ageMs, '4.108.0')], NOW);

    // Assert
    should(actual).deepEqual([
      `older clients still use GET /v1/sessions/*/attention: last used ${said} ago by fy 4.108.0`,
    ]);
  });

  it('should leave the version out when the caller sent none', () => {
    // Act + Assert
    should(legacyWireLines([use('GET /v1/x', 2 * HOUR)], NOW)).deepEqual([
      'older clients still use GET /v1/x: last used 2 hours ago',
    ]);
  });

  it('should keep a quiet route in view beside one still in use', () => {
    // Act
    const actual = legacyWireLines(
      [use('POST /v1/a', 2 * DAY, '4.108.0'), use('GET /v1/b', 21 * DAY, '4.100.0'), use('GET /v1/c', 40 * DAY)],
      NOW,
    );

    // Assert
    should(actual).deepEqual([
      'older clients still use POST /v1/a: last used 2 days ago by fy 4.108.0',
      'no older client has used GET /v1/b for 21 days (last by fy 4.100.0)',
      'no older client has used GET /v1/c for 40 days',
    ]);
  });
});

describe('legacy wire report', () => {
  const health = (legacyWire: LegacyWireUse[] | undefined): { probe: () => Promise<HealthView> } => ({
    probe: () => Promise.resolve({ legacyWire } as HealthView),
  });

  it('should render what the daemon reports', async () => {
    // Act + Assert
    should(await legacyWireReport(health([use('GET /v1/x', HOUR, '4.108.0')]), NOW)).deepEqual([
      'older clients still use GET /v1/x: last used 1 hour ago by fy 4.108.0',
    ]);
  });

  it('should print nothing for an older daemon without the field', async () => {
    // Act + Assert
    should(await legacyWireReport(health(undefined), NOW)).deepEqual([]);
  });

  it('should print nothing when the daemon does not answer', async () => {
    // Act + Assert
    should(await legacyWireReport({ probe: () => Promise.resolve(undefined) }, NOW)).deepEqual([]);
  });
});
