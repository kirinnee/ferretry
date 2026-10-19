import { describe, it } from 'bun:test';
import should from 'should';
import {
  foldLivenessSample,
  type LivenessTrack,
  paneWorkCounters,
  reflexAssess,
  reflexSettingsFor,
  reflexStep,
  startTrack,
  withLivenessLedger,
} from '../../../src/lib/warden/index.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const at = (seconds: number): string => new Date(NOW + seconds * 1000).toISOString();
const SETTINGS = { nudgeAfterSeconds: 300, frozenAfterSeconds: 900, tickSeconds: 30 };

/** A frame Claude Code paints while it works. */
const working = (elapsed: string, tokens: string): string =>
  `✢ Fixing… (${elapsed} · ↓ ${tokens} tokens · esc to interrupt)`;

describe('the work counters on a screen', () => {
  it('should read the elapsed time and the tokens from an active-work frame', () => {
    // Act / Assert
    should(paneWorkCounters(working('5m 45s', '17.2k'))).deepEqual({ elapsedSeconds: 345, tokens: 17_200 });
    should(paneWorkCounters(working('1h 2m 3s', '1,200'))).deepEqual({ elapsedSeconds: 3723, tokens: 1200 });
  });

  it('should read whichever counter is there, and nothing from a screen that shows no work', () => {
    // Act / Assert
    should(paneWorkCounters('✻ Working… (esc to interrupt) 900 tokens')).deepEqual({ tokens: 900 });
    should(paneWorkCounters('✻ Working… (12s · esc to interrupt)')).deepEqual({ elapsedSeconds: 12 });
    should(paneWorkCounters('✻ Working… (esc to interrupt)')).be.undefined();
    should(paneWorkCounters('Total: (5s) 20 tokens')).be.undefined();
  });
});

describe('folding a look into the ledger', () => {
  it('should take the first look as a baseline and stamp only what changed after it', () => {
    // Arrange
    const first = foldLivenessSample(undefined, { paneHash: 'a', transcriptHash: 't' }, 1, NOW);

    // Act
    const pane = foldLivenessSample(first, { paneHash: 'b', transcriptHash: 't' }, 1, NOW + 30_000);
    const transcript = foldLivenessSample(pane, { paneHash: 'b', transcriptHash: 'u' }, 1, NOW + 60_000);

    // Assert
    should(first.ledger).deepEqual({});
    should(first.anchorAt).equal(at(0));
    should(pane.ledger).deepEqual({ lastPaneChangeAt: at(30) });
    should(transcript.ledger).deepEqual({ lastPaneChangeAt: at(30), lastTranscriptAt: at(60) });
  });

  it('should credit counters only when they strictly advance, and tokens only when they climb', () => {
    // Arrange
    const start = foldLivenessSample(undefined, { pane: working('10s', '1.0k') }, 1, NOW);

    // Act
    const clock = foldLivenessSample(start, { pane: working('40s', '1.0k') }, 1, NOW + 30_000);
    const tokens = foldLivenessSample(clock, { pane: working('40s', '2.0k') }, 1, NOW + 60_000);
    const frozen = foldLivenessSample(tokens, { pane: working('40s', '2.0k') }, 1, NOW + 90_000);
    const blank = foldLivenessSample(frozen, { pane: 'nothing working here' }, 1, NOW + 120_000);

    // Assert
    should(clock.ledger).deepEqual({ lastCounterAdvanceAt: at(30) });
    should(tokens.ledger).deepEqual({ lastCounterAdvanceAt: at(60), lastTokenAdvanceAt: at(60) });
    should(frozen.ledger).deepEqual(tokens.ledger);
    should(blank.counters).deepEqual(frozen.counters);
  });

  it('should open a subprocess episode, keep it while alive, and close it the first tick it is gone', () => {
    // Arrange
    const seen = foldLivenessSample(undefined, { subprocessAlive: true }, 1, NOW);

    // Act
    const still = foldLivenessSample(seen, { subprocessAlive: true }, 1, NOW + 30_000);
    const unknown = foldLivenessSample(still, {}, 1, NOW + 60_000);
    const gone = foldLivenessSample(unknown, { subprocessAlive: false }, 1, NOW + 90_000);

    // Assert
    should(still.ledger).deepEqual({ lastSubprocessAt: at(30), subprocessSince: at(0) });
    should(unknown.ledger).deepEqual(still.ledger);
    should(gone.ledger).deepEqual({ lastSubprocessAt: at(30) });
  });

  it('should start every clock again on a new turn', () => {
    // Arrange
    const old = foldLivenessSample(
      { ...startTrack(1, NOW), paneHash: 'a', nudgedAt: at(0) },
      { paneHash: 'b' },
      1,
      NOW,
    );

    // Act
    const next = foldLivenessSample(old, { paneHash: 'c' }, 2, NOW + 30_000);

    // Assert
    should(next).deepEqual({ ledger: {}, turn: 2, anchorAt: at(30), frozenTicks: 0, paneHash: 'c' });
  });
});

describe('the reflex rule', () => {
  const quiet = (seconds: number, overrides: Partial<LivenessTrack> = {}): LivenessTrack => ({
    ...startTrack(1, NOW - seconds * 1000),
    ...overrides,
  });

  it('should leave a ferret alone while any life-sign is recent', () => {
    // Act
    const actual = reflexAssess(quiet(600, { ledger: { lastPaneChangeAt: at(-60) } }), NOW, SETTINGS, true);

    // Assert
    should(actual).match({ verdict: 'alive', quietSeconds: 60, strongQuietSeconds: 600 });
  });

  it('should nudge once after the nudge time, and freeze only after a nudge', () => {
    // Act / Assert
    should(reflexAssess(quiet(300), NOW, SETTINGS, true).verdict).equal('nudge');
    should(reflexAssess(quiet(1000), NOW, SETTINGS, true).verdict).equal('nudge');
    should(reflexAssess(quiet(600, { nudgedAt: at(-300) }), NOW, SETTINGS, true).verdict).equal('alive');
    should(reflexAssess(quiet(900, { nudgedAt: at(-600) }), NOW, SETTINGS, true).verdict).equal('frozen');
  });

  it('should freeze without waiting for a nudge the owner never allowed', () => {
    // Act / Assert
    should(reflexAssess(quiet(600), NOW, SETTINGS, false).verdict).equal('alive');
    should(reflexAssess(quiet(900), NOW, SETTINGS, false).verdict).equal('frozen');
  });

  it('should count a subprocess seen within two ticks as alive, and never a screen change as strong', () => {
    // Arrange
    const running = quiet(2000, { ledger: { lastSubprocessAt: at(-45) }, nudgedAt: at(-900) });
    const flicker = quiet(2000, { ledger: { lastPaneChangeAt: at(-1) }, nudgedAt: at(-900) });

    // Act / Assert
    should(reflexAssess(running, NOW, SETTINGS, true)).match({ verdict: 'alive', strongQuietSeconds: 0 });
    should(reflexAssess(flicker, NOW, SETTINGS, true).verdict).equal('frozen');
  });

  it('should read an unreadable anchor as now', () => {
    // Act / Assert
    should(reflexAssess({ ...quiet(0), anchorAt: 'garbage' }, NOW, SETTINGS, true).verdict).equal('alive');
  });
});

describe('a reflex step', () => {
  const quiet = (seconds: number, overrides: Partial<LivenessTrack> = {}): LivenessTrack => ({
    ...startTrack(1, NOW - seconds * 1000),
    ...overrides,
  });
  const options = { nudgeAllowed: true, suspended: false };

  it('should nudge once and remember it', () => {
    // Act
    const actual = reflexStep(quiet(300), NOW, SETTINGS, options);

    // Assert
    should(actual).match({ nudge: true, frozen: false, track: { nudgedAt: at(0), frozenTicks: 0 } });
  });

  it('should confirm frozen on the second frozen tick, and report it once', () => {
    // Arrange
    const first = reflexStep(quiet(900, { nudgedAt: at(-600) }), NOW, SETTINGS, options);

    // Act
    const second = reflexStep(first.track, NOW + 30_000, SETTINGS, options);
    const third = reflexStep(second.track, NOW + 60_000, SETTINGS, options);

    // Assert
    should(first).match({ frozen: false, track: { frozenTicks: 1 } });
    should(second).match({ frozen: true, track: { frozenAt: at(30), frozenTicks: 2 } });
    should(third).match({ frozen: false, track: { frozenAt: at(30), frozenTicks: 3 } });
  });

  it('should end the episode when a strong life-sign returns, and keep it on mere flicker', () => {
    // Arrange
    const episode = { nudgedAt: at(-60), frozenAt: at(-30), frozenTicks: 2 };

    // Act
    const revived = reflexStep(
      quiet(2000, { ...episode, ledger: { lastTranscriptAt: at(-5) } }),
      NOW,
      SETTINGS,
      options,
    );
    const flicker = reflexStep(
      quiet(400, { ...episode, nudgedAt: at(-150), ledger: { lastPaneChangeAt: at(-5) } }),
      NOW,
      SETTINGS,
      options,
    );

    // Assert
    should(revived.track).not.have.properties(['nudgedAt', 'frozenAt']);
    should(revived.track.frozenTicks).equal(0);
    should(flicker.track).match({ nudgedAt: at(-150), frozenAt: at(-30), frozenTicks: 0 });
  });

  it('should never nudge or freeze a suspended ferret', () => {
    // Act
    const actual = reflexStep(quiet(5000, { nudgedAt: at(-4000) }), NOW, SETTINGS, { ...options, suspended: true });

    // Assert
    should(actual).match({ nudge: false, frozen: false });
  });
});

describe('the reflex times for a ferret', () => {
  it('should use its own times, the defaults otherwise, and keep frozen a tick after the nudge', () => {
    // Act / Assert
    should(reflexSettingsFor({}, 30)).deepEqual({ nudgeAfterSeconds: 300, frozenAfterSeconds: 900, tickSeconds: 30 });
    should(reflexSettingsFor({ nudgeAfterSeconds: 0, killAfterSeconds: 0 }, 30)).match({ nudgeAfterSeconds: 300 });
    should(reflexSettingsFor({ nudgeAfterSeconds: 120, killAfterSeconds: 600 }, 30)).match({
      nudgeAfterSeconds: 120,
      frozenAfterSeconds: 600,
    });
    should(reflexSettingsFor({ nudgeAfterSeconds: 600, killAfterSeconds: 300 }, 30)).match({ frozenAfterSeconds: 630 });
  });
});

describe('laying the ledger over a ferret’s state', () => {
  it('should take the later of each signal and the monitor’s subprocess episode alone', () => {
    // Arrange
    const state = {
      status: 'running' as const,
      lastTranscriptAt: at(-10),
      lastPaneAt: at(-100),
      subprocessSince: at(-500),
    };

    // Act
    const actual = withLivenessLedger(state, {
      lastTranscriptAt: at(-50),
      lastPaneChangeAt: at(-5),
      lastCounterAdvanceAt: at(-1),
    });

    // Assert
    should(actual).deepEqual({
      status: 'running',
      lastTranscriptAt: at(-10),
      lastPaneAt: at(-5),
      lastCounterAdvanceAt: at(-1),
    });
    should(withLivenessLedger(state, undefined)).equal(state);
  });
});
