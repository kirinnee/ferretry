import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifySelfCheckTick,
  defaultSessionHealthSettings,
  emptySelfCheckLedger,
  parseSessionHealthSettings,
  recordSelfCheckTick,
  wedgeEvent,
  type SelfCheckLedger,
} from '../../../../src/lib/session/health/index.ts';

const SETTINGS = defaultSessionHealthSettings;
const AT = '2026-07-31T10:00:00.000Z';

function ledger(overrides: Partial<SelfCheckLedger> = {}): SelfCheckLedger {
  return { ...emptySelfCheckLedger, ticks: 1, lastElapsedMs: 1_000_000, lastAt: AT, ...overrides };
}

describe('self-check wedge detection', () => {
  it('should treat the very first tick as a boot pass rather than a gap it cannot measure', () => {
    // Arrange
    const first = emptySelfCheckLedger;

    // Act
    const actual = classifySelfCheckTick(first, { elapsedMs: 5_000, at: AT }, SETTINGS);

    // Assert
    should(actual).deepEqual({
      freshness: 'first-tick',
      gapMs: undefined,
      lagMs: 0,
      deepPass: true,
      since: undefined,
    });
  });

  it('should call an on-time tick fresh and report only the excess as event loop lag', () => {
    // Arrange
    const previous = ledger();

    // Act
    const actual = classifySelfCheckTick(previous, { elapsedMs: 1_064_000, at: AT }, SETTINGS);

    // Assert
    should(actual.freshness).equal('fresh');
    should(actual.gapMs).equal(64_000);
    should(actual.lagMs).equal(4_000);
    should(actual.deepPass).be.false();
    should(actual.since).be.undefined();
  });

  it('should declare a wedge once the gap reaches the configured threshold and date it backwards', () => {
    // Arrange
    const previous = ledger();

    // Act
    const actual = classifySelfCheckTick(previous, { elapsedMs: 1_000_000 + SETTINGS.wedgeGapMs, at: AT }, SETTINGS);

    // Assert
    should(actual.freshness).equal('wedged');
    should(actual.gapMs).equal(SETTINGS.wedgeGapMs);
    should(actual.deepPass).be.true();
    should(actual.since).equal('2026-07-31T09:57:00.000Z');
  });

  it('should stay one millisecond below the threshold rather than rounding a slow tick into a wedge', () => {
    // Arrange
    const previous = ledger();

    // Act
    const actual = classifySelfCheckTick(
      previous,
      { elapsedMs: 1_000_000 + SETTINGS.wedgeGapMs - 1, at: AT },
      SETTINGS,
    );

    // Assert
    should(actual.freshness).equal('fresh');
    should(actual.deepPass).be.false();
  });

  it('should omit the wedge start when the wall instant itself is unusable', () => {
    // Arrange
    const previous = ledger();

    // Act
    const actual = classifySelfCheckTick(
      previous,
      { elapsedMs: 1_000_000 + SETTINGS.wedgeGapMs, at: 'not-an-instant' },
      SETTINGS,
    );

    // Assert
    should(actual.freshness).equal('wedged');
    should(actual.since).be.undefined();
  });

  it('should refuse to call a backwards monotonic reading fresh', () => {
    // Arrange — the failure mode the ancestor had: a negative gap read as an on-time tick.
    const previous = ledger();

    // Act
    const actual = classifySelfCheckTick(previous, { elapsedMs: 900_000, at: AT }, SETTINGS);

    // Assert
    should(actual.freshness).equal('unknown');
    should(actual.gapMs).be.undefined();
    should(actual.deepPass).be.true();
  });

  it('should refuse to call a non-finite reading fresh', () => {
    // Arrange
    const previous = ledger();

    // Act
    const actual = classifySelfCheckTick(previous, { elapsedMs: Number.NaN, at: AT }, SETTINGS);

    // Assert
    should(actual.freshness).equal('unknown');
    should(actual.deepPass).be.true();
  });

  it('should treat a missing baseline after the first tick as unproven, not as a fresh boot', () => {
    // Arrange
    const previous = ledger({ ticks: 4, lastElapsedMs: undefined });

    // Act
    const actual = classifySelfCheckTick(previous, { elapsedMs: 2_000_000, at: AT }, SETTINGS);

    // Assert
    should(actual.freshness).equal('unknown');
  });
});

describe('self-check ledger', () => {
  it('should count only proven wedges and carry the newest readings forward', () => {
    // Arrange
    const previous = ledger({ wedges: 2 });

    // Act
    const actual = recordSelfCheckTick(previous, { elapsedMs: 1_000_000 + SETTINGS.wedgeGapMs, at: AT }, SETTINGS);

    // Assert
    should(actual.ledger).deepEqual({
      ticks: 2,
      wedges: 3,
      lastElapsedMs: 1_000_000 + SETTINGS.wedgeGapMs,
      lastAt: AT,
      lastFreshness: 'wedged',
      eventLoopLagMs: SETTINGS.wedgeGapMs - SETTINGS.selfCheckIntervalMs,
    });
  });

  it('should not count an unknown tick as a wedge', () => {
    // Arrange
    const previous = ledger();

    // Act
    const actual = recordSelfCheckTick(previous, { elapsedMs: 1, at: AT }, SETTINGS);

    // Assert
    should(actual.ledger.wedges).equal(0);
    should(actual.ledger.lastFreshness).equal('unknown');
  });

  it('should keep the last usable baseline when a reading is unusable, so one bad sample cannot poison the next gap', () => {
    // Arrange
    const previous = ledger();

    // Act
    const actual = recordSelfCheckTick(previous, { elapsedMs: Number.POSITIVE_INFINITY, at: 'nope' }, SETTINGS);

    // Assert
    should(actual.ledger.lastElapsedMs).equal(1_000_000);
    should(actual.ledger.lastAt).equal(AT);
  });

  it('should start from an empty ledger with no history at all', () => {
    // Arrange
    const first = emptySelfCheckLedger;

    // Act
    const actual = recordSelfCheckTick(first, { elapsedMs: 42, at: AT }, SETTINGS);

    // Assert
    should(actual.ledger.ticks).equal(1);
    should(actual.ledger.lastFreshness).equal('first-tick');
    should(actual.ledger.eventLoopLagMs).equal(0);
  });
});

describe('wedge event', () => {
  it('should describe a measured wedge in operator-facing seconds', () => {
    // Arrange
    const verdict = classifySelfCheckTick(ledger(), { elapsedMs: 1_000_000 + 200_000, at: AT }, SETTINGS);

    // Act
    const actual = wedgeEvent(verdict, 7);

    // Assert
    should(actual).deepEqual({
      type: 'fleet.daemon_wedge',
      data: { gapSeconds: 200, lagMs: 140_000, monitors: 7, since: '2026-07-31T09:56:40.000Z' },
    });
  });

  it('should omit an unusable start instant from the event rather than fabricate one', () => {
    // Arrange
    const verdict = classifySelfCheckTick(ledger(), { elapsedMs: 1_000_000 + 200_000, at: 'nope' }, SETTINGS);

    // Act
    const actual = wedgeEvent(verdict, 1);

    // Assert
    should(actual?.data).not.have.property('since');
  });

  it('should produce nothing for a tick that was not a wedge', () => {
    // Arrange
    const verdict = classifySelfCheckTick(ledger(), { elapsedMs: 1_060_000, at: AT }, SETTINGS);

    // Act
    const actual = wedgeEvent(verdict, 3);

    // Assert
    should(actual).be.undefined();
  });
});

describe('session health settings', () => {
  it('should accept the shipped defaults', () => {
    // Arrange
    const input = { ...defaultSessionHealthSettings };

    // Act
    const actual = parseSessionHealthSettings(input);

    // Assert
    should(actual).deepEqual(defaultSessionHealthSettings);
  });

  it('should refuse a wedge threshold at or below the self-check cadence, which would wedge every tick', () => {
    // Arrange
    const input = { ...defaultSessionHealthSettings, wedgeGapMs: defaultSessionHealthSettings.selfCheckIntervalMs };

    // Act / Assert
    should(() => parseSessionHealthSettings(input)).throw(/wedgeGapMs must exceed selfCheckIntervalMs/u);
  });

  it('should refuse a zero restart threshold, which would restart on the first imperfect pass', () => {
    // Arrange
    const input = { ...defaultSessionHealthSettings, incoherentRestartThreshold: 0 };

    // Act / Assert
    should(() => parseSessionHealthSettings(input)).throw();
  });
});
