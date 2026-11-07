import { describe, it } from 'bun:test';
import should from 'should';
import {
  defaultSessionHealthSettings,
  emptySelfCheckLedger,
  launchingRecently,
  planSelfCheck,
  type SelfCheckInput,
  type SessionHealthObservation,
} from '../../../../src/lib/session/health/index.ts';

const SETTINGS = defaultSessionHealthSettings;
const AT = '2026-07-31T10:00:00.000Z';
const NOW_MS = Date.parse(AT);

function session(overrides: Partial<SessionHealthObservation> = {}): SessionHealthObservation {
  return { id: 'session-1', terminal: false, monitored: true, ...overrides };
}

function input(overrides: Partial<SelfCheckInput> = {}): SelfCheckInput {
  return {
    tick: { elapsedMs: 1_060_000, at: AT },
    nowMs: NOW_MS,
    sessions: [session()],
    sweep: { timerArmed: true, lastSweepAt: new Date(NOW_MS - 10_000).toISOString(), intervalMs: 60_000 },
    bootstrapErrors: [],
    supervisesMonitors: true,
    supervisesWarden: true,
    ...overrides,
  };
}

const SETTLED = { ...emptySelfCheckLedger, ticks: 1, lastElapsedMs: 1_000_000, lastAt: AT };

describe('launch amnesty', () => {
  it('should excuse a session whose launch is still in flight', () => {
    // Act
    const actual = launchingRecently(NOW_MS - 5_000, NOW_MS, SETTINGS);

    // Assert
    should(actual).be.true();
  });

  it('should stop excusing a launch that outlived the grace, so a hung bootstrap cannot hide forever', () => {
    // Act
    const actual = launchingRecently(NOW_MS - SETTINGS.launchGraceMs - 1, NOW_MS, SETTINGS);

    // Assert
    should(actual).be.false();
  });

  it('should excuse nothing on evidence it cannot use', () => {
    // Arrange
    const cases: readonly (number | undefined)[] = [undefined, Number.NaN, NOW_MS + 1_000];

    // Act
    const actual = cases.map(since => launchingRecently(since, NOW_MS, SETTINGS));

    // Assert
    should(actual).deepEqual([false, false, false]);
  });

  it('should excuse nothing when its own clock reading is unusable', () => {
    // Act
    const actual = launchingRecently(NOW_MS, Number.NaN, SETTINGS);

    // Assert
    should(actual).be.false();
  });
});

describe('self-check plan', () => {
  it('should do nothing to a healthy fleet and emit no events', () => {
    // Act
    const actual = planSelfCheck(SETTLED, input(), SETTINGS);

    // Assert
    should(actual.plan.startMonitors).deepEqual([]);
    should(actual.plan.rearmWarden).be.false();
    should(actual.plan.deepPass).be.false();
    should(actual.plan.events).deepEqual([]);
    should(actual.ledger.ticks).equal(2);
  });

  it('should repair a live session that lost its monitor', () => {
    // Arrange
    const sessions = [session(), session({ id: 'orphan', monitored: false })];

    // Act
    const actual = planSelfCheck(SETTLED, input({ sessions }), SETTINGS);

    // Assert
    should(actual.plan.startMonitors).deepEqual(['orphan']);
    should(actual.plan.events).have.length(1);
    should(actual.plan.events[0]?.type).equal('fleet.self_check_failed');
    should(actual.plan.events[0]?.data.unmonitoredRunning).deepEqual(['orphan']);
  });

  it('should leave terminal sessions and in-flight launches alone', () => {
    // Arrange
    const sessions = [
      session({ id: 'finished', terminal: true, monitored: false }),
      session({ id: 'launching', monitored: false, launchingSinceMs: NOW_MS - 1_000 }),
    ];

    // Act
    const actual = planSelfCheck(SETTLED, input({ sessions }), SETTINGS);

    // Assert
    should(actual.plan.startMonitors).deepEqual([]);
    should(actual.plan.events).deepEqual([]);
  });

  it('should re-arm a warden whose sweeps stopped and say so in the event', () => {
    // Arrange
    const sweep = { timerArmed: true, lastSweepAt: new Date(NOW_MS - 3_600_000).toISOString(), intervalMs: 60_000 };

    // Act
    const actual = planSelfCheck(SETTLED, input({ sweep }), SETTINGS);

    // Assert
    should(actual.plan.rearmWarden).be.true();
    should(actual.plan.events[0]?.data.wardenSweepState).equal('stale');
    should(actual.plan.events[0]?.data.wardenLastSweepAt).equal(sweep.lastSweepAt);
  });

  it('should omit a sweep timestamp it never had', () => {
    // Arrange
    const sweep = { timerArmed: false, intervalMs: 60_000 };

    // Act
    const actual = planSelfCheck(SETTLED, input({ sweep }), SETTINGS);

    // Assert
    should(actual.plan.rearmWarden).be.true();
    should(actual.plan.events[0]?.data).not.have.property('wardenLastSweepAt');
  });

  it('should force the deep pass and record the wedge when the tick was starved', () => {
    // Arrange
    const tick = { elapsedMs: 1_000_000 + SETTINGS.wedgeGapMs, at: AT };

    // Act
    const actual = planSelfCheck(SETTLED, input({ tick }), SETTINGS);

    // Assert
    should(actual.plan.deepPass).be.true();
    should(actual.plan.events[0]?.type).equal('fleet.daemon_wedge');
    should(actual.plan.events[0]?.data.monitors).equal(1);
    should(actual.ledger.wedges).equal(1);
  });

  it('should force the deep pass on a tick it could not measure, without counting a wedge', () => {
    // Act
    const actual = planSelfCheck(SETTLED, input({ tick: { elapsedMs: 1, at: AT } }), SETTINGS);

    // Assert
    should(actual.plan.deepPass).be.true();
    should(actual.ledger.wedges).equal(0);
    should(actual.plan.events).deepEqual([]);
  });

  it('should plan no monitor repair on a daemon that runs no monitors', () => {
    // Arrange — planning a repair the daemon cannot perform would be re-planned on every tick.
    const sessions = [session({ id: 'orphan', monitored: false })];

    // Act
    const actual = planSelfCheck(SETTLED, input({ sessions, supervisesMonitors: false }), SETTINGS);

    // Assert
    should(actual.plan.startMonitors).deepEqual([]);
    should(actual.plan.events).deepEqual([]);
  });

  it('should plan no warden re-arm on a daemon that arms no warden', () => {
    // Arrange
    const sweep = { timerArmed: false, intervalMs: 60_000 };

    // Act
    const actual = planSelfCheck(SETTLED, input({ sweep, supervisesWarden: false }), SETTINGS);

    // Assert
    should(actual.plan.rearmWarden).be.false();
    should(actual.plan.sweep.state).equal('timer-dead');
    should(actual.plan.events).deepEqual([]);
  });

  it('should carry the bootstrap error count into the failure event', () => {
    // Arrange
    const sessions = [session({ id: 'orphan', monitored: false })];

    // Act
    const actual = planSelfCheck(
      SETTLED,
      input({ sessions, bootstrapErrors: ['transcript import timed out'] }),
      SETTINGS,
    );

    // Assert
    should(actual.plan.events[0]?.data.bootstrapErrors).equal(1);
  });
});
