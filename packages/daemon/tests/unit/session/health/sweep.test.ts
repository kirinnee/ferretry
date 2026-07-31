import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifyWardenSweep,
  defaultSessionHealthSettings,
  wardenSweepDeadlineMs,
  type WardenSweepObservation,
} from '../../../../src/lib/session/health/index.ts';

const SETTINGS = defaultSessionHealthSettings;
const NOW_MS = Date.parse('2026-07-31T10:00:00.000Z');
const INTERVAL_MS = 60_000;
const DEADLINE_MS = wardenSweepDeadlineMs(INTERVAL_MS, SETTINGS);

function observation(overrides: Partial<WardenSweepObservation> = {}): WardenSweepObservation {
  return { timerArmed: true, nowMs: NOW_MS, intervalMs: INTERVAL_MS, ...overrides };
}

describe('warden sweep deadline', () => {
  it('should widen for a slow configured interval instead of capping it', () => {
    // Arrange
    const interval = 10 * 60_000;

    // Act
    const actual = wardenSweepDeadlineMs(interval, SETTINGS);

    // Assert
    should(actual).equal(interval * SETTINGS.wardenSweepStaleIntervals);
  });

  it('should never fall below the configured floor for a fast or absurd interval', () => {
    // Arrange
    const cases = [0, -1, Number.NaN, 1_000];

    // Act
    const actual = cases.map(interval => wardenSweepDeadlineMs(interval, SETTINGS));

    // Assert
    should(actual).deepEqual(cases.map(() => SETTINGS.wardenSweepStaleFloorMs));
  });
});

describe('warden sweep classification', () => {
  it('should call a recent sweep fresh and leave the warden alone', () => {
    // Arrange
    const input = observation({ lastSweepAt: new Date(NOW_MS - 30_000).toISOString() });

    // Act
    const actual = classifyWardenSweep(input, SETTINGS);

    // Assert
    should(actual.state).equal('fresh');
    should(actual.needsRearm).be.false();
    should(actual.ageMs).equal(30_000);
    should(actual.deadlineMs).equal(DEADLINE_MS);
  });

  it('should call a sweep past the deadline stale', () => {
    // Arrange
    const input = observation({
      lastSweepAt: new Date(NOW_MS - DEADLINE_MS - 1).toISOString(),
    });

    // Act
    const actual = classifyWardenSweep(input, SETTINGS);

    // Assert
    should(actual.state).equal('stale');
    should(actual.needsRearm).be.true();
  });

  it('should report a dead timer without needing any timestamp at all', () => {
    // Arrange
    const input = observation({ timerArmed: false, lastSweepAt: new Date(NOW_MS).toISOString() });

    // Act
    const actual = classifyWardenSweep(input, SETTINGS);

    // Assert
    should(actual).deepEqual({
      state: 'timer-dead',
      needsRearm: true,
      ageMs: undefined,
      deadlineMs: DEADLINE_MS,
    });
  });

  it('should refuse to call an unparseable sweep timestamp fresh', () => {
    // Arrange — the ancestor's `lastSweepMs > 0` test silently passed this, reporting all-clear.
    const input = observation({ lastSweepAt: 'yesterday-ish' });

    // Act
    const actual = classifyWardenSweep(input, SETTINGS);

    // Assert
    should(actual.state).equal('unknown');
    should(actual.needsRearm).be.true();
    should(actual.ageMs).be.undefined();
  });

  it('should refuse to age a sweep dated in the future', () => {
    // Arrange
    const input = observation({ lastSweepAt: new Date(NOW_MS + 60_000).toISOString() });

    // Act
    const actual = classifyWardenSweep(input, SETTINGS);

    // Assert
    should(actual.state).equal('unknown');
    should(actual.needsRearm).be.true();
  });

  it('should refuse to trust an unusable clock reading', () => {
    // Arrange
    const input = observation({ nowMs: Number.NaN, lastSweepAt: new Date(NOW_MS).toISOString() });

    // Act
    const actual = classifyWardenSweep(input, SETTINGS);

    // Assert
    should(actual.state).equal('unknown');
    should(actual.needsRearm).be.true();
  });

  it('should give a freshly armed timer its first interval before judging it', () => {
    // Arrange
    const input = observation({ armedAtMs: NOW_MS - 10_000 });

    // Act
    const actual = classifyWardenSweep(input, SETTINGS);

    // Assert
    should(actual.state).equal('within-grace');
    should(actual.needsRearm).be.false();
    should(actual.ageMs).equal(10_000);
  });

  it('should call an armed timer that never swept within its deadline stale', () => {
    // Arrange
    const input = observation({ armedAtMs: NOW_MS - DEADLINE_MS - 1 });

    // Act
    const actual = classifyWardenSweep(input, SETTINGS);

    // Assert
    should(actual.state).equal('stale');
    should(actual.needsRearm).be.true();
  });

  it('should refuse to trust an armed timer that can be dated by nothing', () => {
    // Arrange
    const cases: readonly WardenSweepObservation[] = [
      observation(),
      observation({ armedAtMs: Number.NaN }),
      observation({ armedAtMs: NOW_MS + 5_000 }),
    ];

    // Act
    const actual = cases.map(input => classifyWardenSweep(input, SETTINGS));

    // Assert
    should(actual.map(verdict => verdict.state)).deepEqual(['unknown', 'unknown', 'unknown']);
    should(actual.every(verdict => verdict.needsRearm)).be.true();
  });
});
