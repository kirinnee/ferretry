import { describe, expect, it } from 'bun:test';
import { activeDisable, disabledUntilMs } from '../../../daemon/lib/shared/disabled.ts';

const NOW = Date.parse('2026-11-01T10:00:00Z');

describe('disabledUntilMs — the instant `until` names', () => {
  it('should read a bare date as the start of that day in UTC, and a time as itself', () => {
    expect(disabledUntilMs('2026-11-05')).toBe(Date.parse('2026-11-05T00:00:00Z'));
    expect(disabledUntilMs('2026-11-05T09:30:00+02:00')).toBe(Date.parse('2026-11-05T07:30:00Z'));
  });

  it('should name no instant for nothing, or for text that is not a time', () => {
    expect(disabledUntilMs(undefined)).toBeUndefined();
    expect(disabledUntilMs('someday')).toBeUndefined();
  });
});

describe('activeDisable — a switch is off only until its `until`', () => {
  it('should be no block when nothing is disabled', () => {
    expect(activeDisable(undefined, NOW)).toBeUndefined();
  });

  it('should keep a block with no `until` for ever, and one whose `until` is still ahead', () => {
    const forever = { reason: 'spend limit' };
    const later = { reason: 'spend limit', until: '2026-11-02T00:00:00Z' };
    expect(activeDisable(forever, NOW)).toBe(forever);
    expect(activeDisable(later, NOW)).toBe(later);
  });

  it('should drop a block the moment its `until` falls due, with no edit', () => {
    expect(activeDisable({ until: '2026-11-01T10:00:00Z' }, NOW)).toBeUndefined();
    expect(activeDisable({ until: '2026-10-31' }, NOW)).toBeUndefined();
  });

  it('should keep a block whose `until` is not a time it can read, rather than lift it by accident', () => {
    const unreadable = { until: 'someday' };
    expect(activeDisable(unreadable, NOW)).toBe(unreadable);
  });
});
