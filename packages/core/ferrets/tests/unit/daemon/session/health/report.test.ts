import { describe, it } from 'bun:test';
import should from 'should';
import {
  buildDaemonHealthReport,
  emptySelfCheckLedger,
  type DaemonHealthInput,
  type SelfCheckLedger,
  type WardenSweepVerdict,
} from '../../../../src/lib/session/health/index.ts';

const AT = '2026-07-31T10:00:00.000Z';
const FRESH_SWEEP: WardenSweepVerdict = { state: 'fresh', needsRearm: false, ageMs: 20_000, deadlineMs: 120_000 };

function ledger(overrides: Partial<SelfCheckLedger> = {}): SelfCheckLedger {
  return { ...emptySelfCheckLedger, ticks: 5, lastAt: AT, lastFreshness: 'fresh', ...overrides };
}

function input(overrides: Partial<DaemonHealthInput> = {}): DaemonHealthInput {
  return {
    bootstrapFinished: true,
    bootstrapErrors: [],
    supervisesMonitors: true,
    supervisesWarden: true,
    sessions: [
      { id: 'a', terminal: false, monitored: true },
      { id: 'b', terminal: true, monitored: false },
    ],
    ledger: ledger(),
    sweep: FRESH_SWEEP,
    version: '0.17.0',
    at: AT,
    ...overrides,
  };
}

describe('daemon health report', () => {
  it('should report a healthy daemon with its counts', () => {
    // Act
    const actual = buildDaemonHealthReport(input());

    // Assert
    should(actual).deepEqual({
      ok: true,
      bootstrapping: false,
      bootstrapState: 'complete',
      version: '0.17.0',
      sessions: 2,
      running: 1,
      monitors: 1,
      unmonitoredRunning: 0,
      supervisesMonitors: true,
      supervisesWarden: true,
      wardenSweepState: 'fresh',
      wardenSweepAgeSeconds: 20,
      selfCheckFreshness: 'fresh',
      selfChecks: 5,
      eventLoopLagMs: 0,
      lastSelfCheckAt: AT,
      wedgeCount: 0,
      bootstrapErrors: 0,
      time: AT,
    });
  });

  it('should refuse an all-clear while a live session has no monitor', () => {
    // Arrange
    const sessions = [{ id: 'a', terminal: false, monitored: false }];

    // Act
    const actual = buildDaemonHealthReport(input({ sessions }));

    // Assert
    should(actual.ok).be.false();
    should(actual.unmonitoredRunning).equal(1);
  });

  it('should refuse an all-clear when the warden is armed but its sweeps stopped', () => {
    // Arrange — an armed timer alone satisfied the ancestor's `ok`.
    const sweep: WardenSweepVerdict = { state: 'stale', needsRearm: true, ageMs: 900_000, deadlineMs: 120_000 };

    // Act
    const actual = buildDaemonHealthReport(input({ sweep }));

    // Assert
    should(actual.ok).be.false();
    should(actual.wardenSweepState).equal('stale');
  });

  it('should refuse an all-clear on the tick after a measured wedge', () => {
    // Act
    const actual = buildDaemonHealthReport(input({ ledger: ledger({ lastFreshness: 'wedged', wedges: 2 }) }));

    // Assert
    should(actual.ok).be.false();
    should(actual.wedgeCount).equal(2);
  });

  it('should refuse an all-clear on a tick that could not be measured at all', () => {
    // Act
    const actual = buildDaemonHealthReport(input({ ledger: ledger({ lastFreshness: 'unknown' }) }));

    // Assert
    should(actual.ok).be.false();
  });

  it('should not hold boot against a daemon whose first tick has not fired', () => {
    // Arrange
    const sweep: WardenSweepVerdict = { state: 'within-grace', needsRearm: false, ageMs: 5_000, deadlineMs: 120_000 };

    // Act
    const actual = buildDaemonHealthReport(input({ ledger: emptySelfCheckLedger, sweep }));

    // Assert
    should(actual.ok).be.true();
    should(actual.selfCheckFreshness).be.undefined();
    should(actual.lastSelfCheckAt).be.null();
    should(actual.wardenSweepAgeSeconds).equal(5);
  });

  it('should report a running bootstrap as not yet serviceable', () => {
    // Act
    const actual = buildDaemonHealthReport(input({ bootstrapFinished: false }));

    // Assert
    should(actual.ok).be.false();
    should(actual.bootstrapping).be.true();
    should(actual.bootstrapState).equal('running');
  });

  it('should stay serviceable after a degraded bootstrap that was since repaired, while still showing the errors', () => {
    // Arrange
    const errors = Array.from({ length: 12 }, (_, index) => `import ${index} timed out`);

    // Act
    const actual = buildDaemonHealthReport(input({ bootstrapErrors: errors }));

    // Assert
    should(actual.ok).be.true();
    should(actual.bootstrapState).equal('degraded');
    should(actual.bootstrapErrors).equal(12);
    should(actual.bootstrapErrorMessages).have.length(10);
  });

  it('should not hold an unmounted monitor subsystem against a daemon that never claimed one', () => {
    // Arrange — a capability that was never mounted is not an outage.
    const sessions = [{ id: 'a', terminal: false, monitored: false }];

    // Act
    const actual = buildDaemonHealthReport(input({ sessions, supervisesMonitors: false }));

    // Assert
    should(actual.ok).be.true();
    should(actual.unmonitoredRunning).equal(1);
    should(actual.supervisesMonitors).be.false();
  });

  it('should not hold an unmounted warden against a daemon that never claimed one', () => {
    // Arrange
    const sweep: WardenSweepVerdict = { state: 'timer-dead', needsRearm: true, ageMs: undefined, deadlineMs: 120_000 };

    // Act
    const actual = buildDaemonHealthReport(input({ sweep, supervisesWarden: false }));

    // Assert
    should(actual.ok).be.true();
    should(actual.supervisesWarden).be.false();
  });

  it('should report an unaged sweep as null rather than zero', () => {
    // Arrange
    const sweep: WardenSweepVerdict = { state: 'unknown', needsRearm: true, ageMs: undefined, deadlineMs: 120_000 };

    // Act
    const actual = buildDaemonHealthReport(input({ sweep }));

    // Assert
    should(actual.wardenSweepAgeSeconds).be.null();
    should(actual.ok).be.false();
  });
});
