import { describe, expect, it } from 'bun:test';
import {
  viewerClock,
  viewerizeUtcStamps,
  viewerTime,
  viewerZoneLabel,
  viewerZoneName,
} from '../../../src/shared/viewer-time.ts';

const PST = { timeZone: 'America/Los_Angeles', locale: 'en-US' };

describe('a time on the viewer’s own clock, the zone named', () => {
  it('draws an instant in the zone it is given, with PST said and no UTC in it', () => {
    const words = viewerTime('2026-12-01T08:00:00Z', PST);
    expect(words).toBe('Dec 1, 2026, 12:00 AM PST');
    expect(words).not.toContain('UTC');
  });

  it('names daylight time when the zone is on it', () => {
    expect(viewerTime('2026-07-01T19:30:00Z', PST)).toBe('Jul 1, 2026, 12:30 PM PDT');
  });

  it('moves with the zone: the same instant is another clock, and another label, elsewhere', () => {
    expect(viewerTime('2026-11-02T09:00:00Z', { timeZone: 'Asia/Tokyo', locale: 'en-US' })).toBe(
      'Nov 2, 2026, 6:00 PM GMT+9',
    );
  });

  it('draws the time alone, and the label alone', () => {
    expect(viewerClock(Date.parse('2026-12-01T22:05:00Z'), PST)).toBe('2:05 PM PST');
    expect(viewerZoneLabel(PST, new Date('2026-12-01T00:00:00Z'))).toBe('PST');
    expect(viewerZoneName(PST)).toBe('America/Los_Angeles');
  });

  it('hands back what is not an instant, unchanged', () => {
    expect(viewerTime('soon', PST)).toBe('soon');
    expect(viewerClock('soon', PST)).toBe('soon');
  });

  it('replaces each UTC stamp in a sentence the daemon wrote, and nothing else', () => {
    expect(viewerizeUtcStamps('On a phone, 2026-11-02 09:00 UTC', PST)).toBe('On a phone, Nov 2, 2026, 1:00 AM PST');
    expect(viewerizeUtcStamps('At this machine, 3 uses left', PST)).toBe('At this machine, 3 uses left');
  });
});
