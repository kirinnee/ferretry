import { describe, it } from 'bun:test';
import should from 'should';
import { NotificationHealthMonitor } from '../../../src/adapters/notifications/notification-health-monitor.ts';
import { readDoctorReport } from '../../../src/lib/core/doctor.ts';
import { type NotificationHealthReading, notificationHealthChecks } from '../../../src/lib/notifications/health.ts';

const EARLY = '2026-10-31T10:00:00.000Z';
const LATE = '2026-10-31T11:00:00.000Z';

const healthy: NotificationHealthReading = {
  enrolled: 2,
  ledger: {
    readable: true,
    skipped: 0,
    latestOutcome: { v: 1, phase: 'outcome', key: 'agenda:s:A1:ping', at: EARLY, delivered: 2, failed: 0 },
  },
};

const main = (reading: NotificationHealthReading) => notificationHealthChecks(reading)[0];

describe('notificationHealthChecks', () => {
  it('should report a working pipeline as present, with its enrolled devices and newest push', () => {
    // Act
    const checks = notificationHealthChecks(healthy);

    // Assert
    should(checks).have.length(1);
    should(checks[0]).containDeep({ name: 'notifications', status: 'present', requirement: 'capability' });
    should(checks[0]?.summary).equal(`2 devices enrolled; the newest push reached 2 at ${EARLY}`);
  });

  it('should fail the row for a ledger it cannot read', () => {
    // Act
    const check = main({ ...healthy, ledger: { readable: false, reason: 'permission denied' } });

    // Assert
    should(check).containDeep({ status: 'missing', summary: 'notifications.jsonl cannot be read: permission denied' });
  });

  it('should fail the row while the newest push failed, and clear it once a later push is made', () => {
    // Arrange
    const lastFailed = { at: LATE, key: 'agenda:s:stopped:x', reason: 'ledger cannot be read' };

    // Act
    const failing = main({ ...healthy, lastFailed, lastMade: { at: EARLY, key: 'agenda:s:A1:ping' } });
    const neverMade = main({ ...healthy, lastFailed });
    const recovered = main({ ...healthy, lastFailed: { ...lastFailed, at: EARLY }, lastMade: { at: LATE, key: 'k' } });

    // Assert
    should(failing).containDeep({
      status: 'missing',
      summary: `the newest push failed at ${LATE}: ledger cannot be read`,
    });
    should(neverMade?.status).equal('missing');
    should(recovered?.status).equal('present');
  });

  it('should fail the row when no device is enrolled', () => {
    // Act
    const check = main({ ...healthy, enrolled: 0 });

    // Assert
    should(check).containDeep({ status: 'missing', summary: 'no device is enrolled for push' });
  });

  it('should fail the row when the newest recorded push errored or reached no device', () => {
    // Arrange
    const outcome = { v: 1 as const, phase: 'outcome' as const, key: 'k', at: EARLY };

    // Act
    const errored = main({
      ...healthy,
      ledger: { readable: true, skipped: 0, latestOutcome: { ...outcome, delivered: 0, failed: 0, error: 'boom' } },
    });
    const refused = main({
      ...healthy,
      ledger: { readable: true, skipped: 0, latestOutcome: { ...outcome, delivered: 0, failed: 1 } },
    });

    // Assert
    should(errored).containDeep({ status: 'missing', summary: `the newest recorded push failed at ${EARLY}: boom` });
    should(refused).containDeep({ status: 'missing' });
    should(refused?.summary).containEql('reached none of its 1 device');
  });

  it('should say a ledger with no push yet, and note skipped lines without failing the row', () => {
    // Act
    const checks = notificationHealthChecks({ enrolled: 1, ledger: { readable: true, skipped: 3 } });

    // Assert
    should(checks[0]).containDeep({ status: 'present', summary: '1 device enrolled; no push recorded yet' });
    should(checks[1]).containDeep({
      name: 'notification log',
      requirement: 'optional',
      status: 'missing',
      summary: '3 unreadable lines in notifications.jsonl skipped',
    });
  });

  it('should appear in the doctor report without making it not ready, and be left out when not read', () => {
    // Arrange
    const input = {
      platform: 'linux' as const,
      executables: { resolve: (name: string) => `/usr/bin/${name}` },
      harnesses: { ready: true, harnesses: [] },
      directorySyscalls: true,
    };

    // Act
    const withRow = readDoctorReport({ ...input, notifications: { ...healthy, enrolled: 0 } });
    const without = readDoctorReport(input);

    // Assert
    should(withRow.checks.find(check => check.name === 'notifications')?.status).equal('missing');
    should(withRow.ready).be.true();
    should(without.checks.some(check => check.name === 'notifications')).be.false();
  });
});

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
