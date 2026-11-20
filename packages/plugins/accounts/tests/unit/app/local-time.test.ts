import { describe, expect, it } from 'bun:test';
import { localizeUtcStamps, localTimeWords } from '../../../app/lib/local-time.ts';

/** This plugin's names for the app's one viewer-time formatter (`packages/app/src/shared/viewer-time.ts`, tested there). */
describe('a time on the viewer’s own clock, the zone named', () => {
  it('draws an instant in the zone it is given, with PST said and no UTC in it', () => {
    const words = localTimeWords('2026-11-02T09:00:00Z', { timeZone: 'America/Los_Angeles', locale: 'en-US' });
    expect(words).toBe('Nov 2, 2026, 1:00 AM PST');
    expect(words).not.toContain('UTC');
  });

  it('moves with the zone: the same instant is a different clock in Tokyo', () => {
    expect(localTimeWords('2026-11-02T09:00:00Z', { timeZone: 'Asia/Tokyo', locale: 'en-US' })).toBe(
      'Nov 2, 2026, 6:00 PM GMT+9',
    );
  });

  it('hands back what is not an instant, unchanged', () => {
    expect(localTimeWords('soon')).toBe('soon');
  });

  it('replaces each UTC stamp in a sentence the daemon wrote, and nothing else', () => {
    const clock = { timeZone: 'America/Los_Angeles', locale: 'en-US' };
    expect(localizeUtcStamps('On Kirin’s phone, 2026-11-02 09:00 UTC', clock)).toBe(
      'On Kirin’s phone, Nov 2, 2026, 1:00 AM PST',
    );
    expect(localizeUtcStamps('At this machine, 3 uses left', clock)).toBe('At this machine, 3 uses left');
  });
});
