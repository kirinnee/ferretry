import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifySelfCheckTick,
  defaultSessionHealthSettings,
  emptySelfCheckLedger,
  parseSessionHealthSettings,
  recordSelfCheckTick,
  recordSkippedTick,
  type SelfCheckLedger,
  sessionHealthSettingsAt,
  wedgeEvent,
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

describe('a self-check tick the whole event loop delayed', () => {
  it('should not call a gap the blocked loop explains a wedge, and run no deep pass for it', () => {
    // Arrange — the 17.7 s Mac shape: the loop was blocked for most of a long gap.
    const previous = ledger({ lastLoopBlockedMs: 5_000 });
    const gap = SETTINGS.wedgeGapMs + 60_000;

    // Act
    const actual = classifySelfCheckTick(
      previous,
      { elapsedMs: 1_000_000 + gap, at: AT, loopBlockedMs: 5_000 + gap - SETTINGS.selfCheckIntervalMs },
      SETTINGS,
    );

    // Assert — still reported as lag, never as a wedge.
    should(actual).deepEqual({
      freshness: 'fresh',
      gapMs: gap,
      lagMs: gap - SETTINGS.selfCheckIntervalMs,
      deepPass: false,
      since: undefined,
    });
  });

  it('should still call the part of a gap the blocked loop does not explain a wedge', () => {
    // Arrange — the loop was blocked for a minute, but the check stopped happening for longer.
    const previous = ledger({ lastLoopBlockedMs: 0 });

    // Act
    const actual = classifySelfCheckTick(
      previous,
      { elapsedMs: 1_000_000 + SETTINGS.wedgeGapMs + 60_000, at: AT, loopBlockedMs: 60_000 },
      SETTINGS,
    );
    const short = classifySelfCheckTick(
      previous,
      { elapsedMs: 1_000_000 + SETTINGS.wedgeGapMs + 60_000, at: AT, loopBlockedMs: 60_001 },
      SETTINGS,
    );

    // Assert
    should(actual).match({ freshness: 'wedged', deepPass: true });
    should(short.freshness).equal('fresh');
  });

  it('should count the whole gap when the loop reading cannot be trusted', () => {
    // Arrange
    const gap = { elapsedMs: 1_000_000 + SETTINGS.wedgeGapMs, at: AT };

    // Act — no meter at all, a meter that went backwards, and a meter with no earlier reading.
    const actual = [
      classifySelfCheckTick(ledger({ lastLoopBlockedMs: 0 }), gap, SETTINGS),
      classifySelfCheckTick(ledger({ lastLoopBlockedMs: 9_000_000 }), { ...gap, loopBlockedMs: 0 }, SETTINGS),
      classifySelfCheckTick(ledger(), { ...gap, loopBlockedMs: SETTINGS.wedgeGapMs }, SETTINGS),
    ];

    // Assert
    should(actual.map(verdict => verdict.freshness)).deepEqual(['wedged', 'wedged', 'wedged']);
  });

  it('should carry the loop reading forward with the tick, and drop one it cannot use', () => {
    // Arrange / Act
    const usable = recordSelfCheckTick(ledger(), { elapsedMs: 1_060_000, at: AT, loopBlockedMs: 42 }, SETTINGS);
    const broken = recordSelfCheckTick(
      ledger({ lastLoopBlockedMs: 42 }),
      { elapsedMs: 1_060_000, at: AT, loopBlockedMs: Number.NaN },
      SETTINGS,
    );

    // Assert
    should([usable.ledger.lastLoopBlockedMs, broken.ledger.lastLoopBlockedMs]).deepEqual([42, undefined]);
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
      lastLoopBlockedMs: undefined,
      lastAt: AT,
      lastFreshness: 'wedged',
      eventLoopLagMs: SETTINGS.wedgeGapMs - SETTINGS.selfCheckIntervalMs,
      deepPassOwed: false,
    });
  });

  it('should take the deep pass a stuck check owed on an otherwise on-time tick, and then owe nothing', () => {
    // Arrange
    const previous = ledger({ deepPassOwed: true });

    // Act
    const actual = recordSelfCheckTick(previous, { elapsedMs: 1_060_000, at: AT }, SETTINGS);

    // Assert
    should(actual.verdict).match({ freshness: 'fresh', deepPass: true });
    should(actual.ledger.deepPassOwed).be.false();
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

describe('skipped self-check tick', () => {
  const SINCE = { elapsedMs: 1_000_000, at: AT };

  it('should move the gap baseline without counting a tick, so the skip is never read as late', () => {
    // Arrange
    const previous = ledger();

    // Act
    const actual = recordSkippedTick(
      previous,
      { tick: { elapsedMs: 1_060_000, at: AT }, running: { since: SINCE, counted: false } },
      SETTINGS,
    );

    // Assert
    should(actual.verdict).be.undefined();
    should(actual.ledger).deepEqual({ ...previous, lastElapsedMs: 1_060_000 });
  });

  it('should count a check running for the wedge threshold as one wedge dated from when it began', () => {
    // Arrange
    const previous = ledger({ wedges: 2 });

    // Act
    const actual = recordSkippedTick(
      previous,
      { tick: { elapsedMs: 1_000_000 + SETTINGS.wedgeGapMs, at: 'later' }, running: { since: SINCE, counted: false } },
      SETTINGS,
    );

    // Assert
    should(actual.verdict).deepEqual({
      freshness: 'wedged',
      gapMs: SETTINGS.wedgeGapMs,
      lagMs: SETTINGS.wedgeGapMs - SETTINGS.selfCheckIntervalMs,
      deepPass: true,
      since: AT,
    });
    should(actual.ledger).match({
      ticks: 1,
      wedges: 3,
      lastElapsedMs: 1_000_000 + SETTINGS.wedgeGapMs,
      lastFreshness: 'wedged',
      deepPassOwed: true,
    });
  });

  it('should count a stuck check once, however many ticks it spans', () => {
    // Arrange
    const previous = ledger({ wedges: 1, lastFreshness: 'wedged', deepPassOwed: true });

    // Act
    const actual = recordSkippedTick(
      previous,
      { tick: { elapsedMs: 1_000_000 + 2 * SETTINGS.wedgeGapMs, at: AT }, running: { since: SINCE, counted: true } },
      SETTINGS,
    );

    // Assert
    should(actual.verdict).be.undefined();
    should(actual.ledger.wedges).equal(1);
    should(actual.ledger.lastElapsedMs).equal(1_000_000 + 2 * SETTINGS.wedgeGapMs);
  });

  it('should prove nothing from readings it cannot trust, and keep the last usable baseline', () => {
    // Arrange
    const previous = ledger();
    const late = 1_000_000 + 10 * SETTINGS.wedgeGapMs;

    // Act
    const brokenTick = recordSkippedTick(
      previous,
      { tick: { elapsedMs: Number.NaN, at: AT }, running: { since: SINCE, counted: false } },
      SETTINGS,
    );
    const brokenStart = recordSkippedTick(
      previous,
      { tick: { elapsedMs: late, at: AT }, running: { since: { elapsedMs: Number.NaN, at: AT }, counted: false } },
      SETTINGS,
    );

    // Assert
    should([brokenTick.verdict, brokenStart.verdict]).deepEqual([undefined, undefined]);
    should(brokenTick.ledger).deepEqual(previous);
    should(brokenStart.ledger).deepEqual({ ...previous, lastElapsedMs: late });
  });

  it('should leave the start out of a stuck check whose start instant is unusable', () => {
    // Arrange / Act
    const actual = recordSkippedTick(
      ledger(),
      {
        tick: { elapsedMs: 1_000_000 + SETTINGS.wedgeGapMs, at: AT },
        running: { since: { elapsedMs: 1_000_000, at: 'nope' }, counted: false },
      },
      SETTINGS,
    );

    // Assert
    should(actual.verdict?.since).be.undefined();
  });
});

describe('a stuck check the whole event loop delayed', () => {
  it('should not count the time the loop was blocked as time the check was stuck', () => {
    // Arrange
    const since = { elapsedMs: 1_000_000, at: AT, loopBlockedMs: 0 };
    const tick = { elapsedMs: 1_000_000 + SETTINGS.wedgeGapMs, at: AT };

    // Act
    const blocked = recordSkippedTick(
      ledger(),
      { tick: { ...tick, loopBlockedMs: 1 }, running: { since, counted: false } },
      SETTINGS,
    );
    const free = recordSkippedTick(
      ledger(),
      { tick: { ...tick, loopBlockedMs: 0 }, running: { since, counted: false } },
      SETTINGS,
    );

    // Assert
    should(blocked.verdict).be.undefined();
    should(blocked.ledger.lastLoopBlockedMs).equal(1);
    should(free.verdict?.freshness).equal('wedged');
  });
});

describe('wedge event', () => {
  it('should leave out a monitor count nobody measured', () => {
    // Arrange
    const verdict = classifySelfCheckTick(ledger(), { elapsedMs: 1_000_000 + 200_000, at: AT }, SETTINGS);

    // Act
    const actual = wedgeEvent(verdict, undefined);

    // Assert
    should(actual?.data).not.have.property('monitors');
  });

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

  it('should reproduce the shipped defaults from the cadence they were written for', () => {
    // The pair is a ratio, not two independent numbers, and this is what proves it.
    // Arrange / Act
    const actual = sessionHealthSettingsAt(defaultSessionHealthSettings.selfCheckIntervalMs);

    // Assert
    should(actual).deepEqual(defaultSessionHealthSettings);
  });

  it('should move the wedge threshold with a configured cadence', () => {
    // A daemon checking every ten seconds must not need eighteen missed ticks to admit it is wedged,
    // and one checking every five minutes must not declare itself wedged while perfectly on time.
    // Arrange / Act
    const brisk = sessionHealthSettingsAt(10_000);
    const relaxed = sessionHealthSettingsAt(300_000);

    // Assert
    should([brisk.selfCheckIntervalMs, brisk.wedgeGapMs]).deepEqual([10_000, 30_000]);
    should([relaxed.selfCheckIntervalMs, relaxed.wedgeGapMs]).deepEqual([300_000, 900_000]);
    // Everything the cadence does not imply is left exactly as shipped.
    should(relaxed.incoherentRestartThreshold).equal(defaultSessionHealthSettings.incoherentRestartThreshold);
  });

  it('should refuse a cadence the schema would not accept, rather than derive a pair from it', () => {
    // Arrange / Act / Assert
    should(() => sessionHealthSettingsAt(0)).throw();
    should(() => sessionHealthSettingsAt(1.5)).throw();
  });
});
