import { describe, it } from 'bun:test';
import should from 'should';
import { NotificationHealthMonitor } from '../../../src/adapters/notifications/index.ts';

const EARLY = '2026-10-31T10:00:00.000Z';
const LATE = '2026-10-31T11:00:00.000Z';

describe('NotificationHealthMonitor', () => {
  it('should log each failure, keep the newest failure and push made, and log a push that reached no device', () => {
    // Arrange
    const lines: string[] = [];
    let now = EARLY;
    const monitor = new NotificationHealthMonitor({ now: () => now }, line => lines.push(line));
    const empty = monitor.snapshot();

    // Act
    monitor.failed('agenda:s:stopped:x', 'ledger cannot be read');
    now = LATE;
    monitor.made('agenda:s:A1:ping', { delivered: 0, failed: 2 });
    monitor.made('agenda:s:A2:ping', { delivered: 1, failed: 0 });

    // Assert
    should(empty).eql({});
    should(monitor.snapshot()).eql({
      lastFailed: { at: EARLY, key: 'agenda:s:stopped:x', reason: 'ledger cannot be read' },
      lastMade: { at: LATE, key: 'agenda:s:A2:ping' },
    });
    should(lines).eql([
      'notifications: push agenda:s:stopped:x failed — ledger cannot be read',
      'notifications: push agenda:s:A1:ping reached none of its 2 device(s)',
    ]);
  });
});
