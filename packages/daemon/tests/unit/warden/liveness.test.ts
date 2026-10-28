import { describe, it } from 'bun:test';
import should from 'should';
import {
  foldLivenessSample,
  type LivenessTrack,
  meaningfulPaneText,
  paneWorkCounters,
  reflexAssess,
  reflexSettingsFor,
  reflexStep,
  startTrack,
  textFingerprint,
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

/** A Claude Code screen: some output, the spinner line, the composer and the status line under it. */
const claudeScreen = (output: string, spinner: string, statusClock: string): string =>
  [
    '⏺ Bash(gh pr checks --watch)',
    `  ⎿  ${output}`,
    '',
    spinner,
    '',
    '────────────────────────────────────────────────────────────── [Hadi] Ferretry ─',
    '❯ ',
    '────────────────────────────────────────────────────────────────────────────────',
    `  👤 dev │ 🤖 Opus 5.5 │ 📂 ferretry                                /rc`,
    `  ⏱ ${statusClock} │ 📊 13% (127k/1M) │ 💰 $1.99`,
    '  ⏵⏵ bypass permissions on · 1 shell',
  ].join('\n');

describe('what counts as the screen moving', () => {
  it('should mask the spinner, the elapsed clock and the status line', () => {
    // Arrange
    const before = claudeScreen('Running…', working('5m 45s', '17.2k'), '1s');
    const after = claudeScreen('Running…', '✶ Fixing… (5m 47s · ↓ 17.2k tokens · esc to interrupt)', '3s');

    // Act / Assert — only the harness's own animation changed.
    should(meaningfulPaneText(after)).equal(meaningfulPaneText(before));
    should(meaningfulPaneText(before)).not.containEql('Opus');
    should(meaningfulPaneText(before)).not.containEql('esc to interrupt');
  });

  it('should see new output as movement', () => {
    // Arrange
    const before = claudeScreen('27 pass, 1 pending', working('5m 45s', '17.2k'), '1s');
    const after = claudeScreen('28 pass, 0 pending', working('5m 47s', '17.2k'), '3s');

    // Act / Assert
    should(meaningfulPaneText(after)).not.equal(meaningfulPaneText(before));
  });

  it('should mask a tool’s own running clock', () => {
    // Act / Assert
    should(meaningfulPaneText('⎿  Running… (3m 2s)')).equal(meaningfulPaneText('⎿  Running… (3m 9s)'));
  });

  it('should fingerprint text stably and differently', () => {
    // Act / Assert
    should(textFingerprint('abc')).equal(textFingerprint('abc'));
    should(textFingerprint('abc')).not.equal(textFingerprint('abd'));
    should(textFingerprint('')).match(/^[0-9a-f]{8}$/u);
  });

  it('should stamp a meaningful change only when more than the animation moved', () => {
    // Arrange
    const first = foldLivenessSample(undefined, { pane: claudeScreen('a', working('1s', '1k'), '1s') }, 1, NOW);

    // Act
    const animated = foldLivenessSample(
      first,
      { pane: claudeScreen('a', working('31s', '1k'), '31s') },
      1,
      NOW + 30_000,
    );
    const moved = foldLivenessSample(
      animated,
      { pane: claudeScreen('b', working('61s', '1k'), '61s') },
      1,
      NOW + 60_000,
    );

    // Assert
    should(animated.ledger.lastMeaningfulPaneAt).be.undefined();
    should(moved.ledger.lastMeaningfulPaneAt).equal(at(60));
  });
});

describe('one command after another', () => {
  it('should start a new episode when a different command is the one running', () => {
    // Arrange
    const first = foldLivenessSample(undefined, { subprocessAlive: true, subprocessKey: 'pid:10' }, 1, NOW);
    const same = foldLivenessSample(first, { subprocessAlive: true, subprocessKey: 'pid:10' }, 1, NOW + 30_000);

    // Act
    const other = foldLivenessSample(same, { subprocessAlive: true, subprocessKey: 'pid:11' }, 1, NOW + 60_000);

    // Assert
    should(same.ledger).match({ subprocessSince: at(0), subprocessKey: 'pid:10' });
    should(other.ledger).match({ subprocessSince: at(60), subprocessKey: 'pid:11', lastSubprocessAt: at(60) });
  });

  it('should close the episode and forget its command once nothing runs', () => {
    // Arrange
    const running = foldLivenessSample(undefined, { subprocessAlive: true, subprocessKey: 'pid:10' }, 1, NOW);

    // Act
    const gone = foldLivenessSample(running, { subprocessAlive: false }, 1, NOW + 30_000);

    // Assert
    should(gone.ledger).not.have.property('subprocessSince');
    should(gone.ledger).not.have.property('subprocessKey');
  });

  it('should start a leftover’s clock only once nothing of the agent’s own runs beside it', () => {
    // Arrange
    const busy = foldLivenessSample(undefined, { subprocessAlive: true, leftoverBrowser: true }, 1, NOW);

    // Act
    const idle = foldLivenessSample(busy, { subprocessAlive: false, leftoverBrowser: true }, 1, NOW + 30_000);

    // Assert
    should(busy).not.have.property('leftoverBrowserSince');
    should(idle.leftoverBrowserSince).equal(at(30));
  });

  it('should remember since when a leftover browser has run, and forget it once it is gone', () => {
    // Arrange
    const seen = foldLivenessSample(undefined, { subprocessAlive: false, leftoverBrowser: true }, 1, NOW);
    const still = foldLivenessSample(seen, { subprocessAlive: false, leftoverBrowser: true }, 1, NOW + 30_000);

    // Act
    const gone = foldLivenessSample(still, { subprocessAlive: false }, 1, NOW + 60_000);
    const unread = foldLivenessSample(still, {}, 1, NOW + 60_000);

    // Assert
    should(still.leftoverBrowserSince).equal(at(0));
    should(gone).not.have.property('leftoverBrowserSince');
    should(unread.leftoverBrowserSince).equal(at(0));
  });
});
