import { describe, it } from 'bun:test';
import should from 'should';
import {
  ActivityLedger,
  BootProgress,
  DEFAULT_EVENT_LOOP_LAG_POLICY,
  DEFAULT_WATCHDOG_LIMIT_MS,
  describeLoopStall,
  describeWatchdogFire,
  EventLoopLagMeter,
  type LoopStall,
  NO_WATCHDOG,
  parseWatchdogLimit,
  WATCHDOG_VARIABLE,
  watchdogShouldFire,
} from '../../../src/lib/runtime/liveness.ts';

/** A clock a test moves by hand. */
const manualClock = (startMs = 1_000_000) => {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (milliseconds: number) => {
      nowMs += milliseconds;
    },
  };
};

describe('ActivityLedger', () => {
  it('should name the work in flight oldest first, each name once', () => {
    // Arrange
    const clock = manualClock();
    const ledger = new ActivityLedger(clock);

    // Act
    ledger.begin('analytics ingest');
    clock.advance(10);
    ledger.begin('turn watcher');
    clock.advance(10);
    ledger.begin('analytics ingest');

    // Assert
    should(ledger.inFlight()).deepEqual(['analytics ingest', 'turn watcher']);
  });

  it('should end an activity once however often it is ended', () => {
    // Arrange
    const clock = manualClock();
    const ledger = new ActivityLedger(clock);
    const end = ledger.begin('self-check');

    // Act
    end();
    clock.advance(5_000);
    end();

    // Assert — a second end must not move the recorded finish past the stall window.
    should(ledger.inFlight()).deepEqual([]);
    should(ledger.overlapping(1_000_001, 1_004_000)).deepEqual([]);
  });

  it('should still name work that finished during a stall, which is how the culprit is caught', () => {
    // A synchronous pass blocks the loop, returns, and its promise settles BEFORE the late timer that
    // measures the stall runs — so asking only what is in flight would miss it.
    // Arrange
    const clock = manualClock();
    const ledger = new ActivityLedger(clock);
    const end = ledger.begin('session listing');
    clock.advance(4_000);
    end();

    // Act
    const suspects = ledger.overlapping(1_000_000, 1_004_000);
    const later = ledger.overlapping(1_004_001, 1_005_000);

    // Assert
    should(suspects).deepEqual(['session listing']);
    should(later).deepEqual([]);
  });

  it('should not name work that started after the window closed', () => {
    // Arrange
    const clock = manualClock();
    const ledger = new ActivityLedger(clock);
    clock.advance(10_000);
    ledger.begin('fleet refresh');

    // Act / Assert
    should(ledger.overlapping(1_000_000, 1_005_000)).deepEqual([]);
  });

  it('should remember a bounded number of finished activities', () => {
    // Arrange
    const clock = manualClock();
    const ledger = new ActivityLedger(clock);
    for (let index = 0; index < 70; index += 1) {
      const end = ledger.begin(`pass ${String(index)}`);
      end();
    }

    // Act
    const remembered = ledger.overlapping(0, Number.MAX_SAFE_INTEGER);

    // Assert
    should(remembered).have.length(64);
    should(remembered[0]).equal('pass 6');
  });

  it('should run work as an activity and end it whether the work settles or throws', async () => {
    // Arrange
    const ledger = new ActivityLedger(manualClock());

    // Act
    const answer = await ledger.run('warden sweep', async () => 42);
    const failed = await ledger
      .run('quota failover', () => Promise.reject(new Error('no feed')))
      .catch((error: Error) => error.message);

    // Assert
    should(answer).equal(42);
    should(failed).equal('no feed');
    should(ledger.inFlight()).deepEqual([]);
  });
});

describe('BootProgress', () => {
  it('should report the step in progress and how long it and the boot have run', () => {
    // Arrange
    const clock = manualClock();
    const ledger = new ActivityLedger(clock);
    const progress = new BootProgress(clock, ledger);
    clock.advance(1_500);

    // Act
    progress.enter('first self-check (reconciling the session index)');
    clock.advance(8_000);
    const snapshot = progress.snapshot();

    // Assert
    should(snapshot).deepEqual({
      phase: 'starting',
      step: 'first self-check (reconciling the session index)',
      stepElapsedMs: 8_000,
      bootElapsedMs: 9_500,
    });
    should(ledger.inFlight()).deepEqual(['boot: first self-check (reconciling the session index)']);
  });

  it('should start on a step named "starting", from the instant it was created', () => {
    // Arrange
    const clock = manualClock();
    const progress = new BootProgress(clock, new ActivityLedger(clock));

    // Act / Assert
    should(progress.snapshot()).deepEqual({ phase: 'starting', step: 'starting', stepElapsedMs: 0, bootElapsedMs: 0 });
  });

  it('should move from starting to finishing to ready, and never back', () => {
    // Arrange
    const clock = manualClock();
    const ledger = new ActivityLedger(clock);
    const progress = new BootProgress(clock, ledger);

    // Act
    progress.serving();
    const finishing = progress.snapshot().phase;
    const finishedEarly = progress.finished;
    progress.finish();
    progress.serving();

    // Assert
    should(finishing).equal('finishing');
    should(finishedEarly).be.false();
    should(progress.snapshot().phase).equal('ready');
    should(progress.finished).be.true();
    should(ledger.inFlight()).deepEqual([]);
  });

  it('should never report a negative elapsed time from a clock that stepped back', () => {
    // Arrange
    const clock = manualClock();
    const progress = new BootProgress(clock, new ActivityLedger(clock));

    // Act
    clock.advance(-5_000);

    // Assert
    should(progress.snapshot().stepElapsedMs).equal(0);
    should(progress.snapshot().bootElapsedMs).equal(0);
  });
});

describe('EventLoopLagMeter', () => {
  it('should measure an on-time tick as no lag and report nothing', () => {
    // Arrange
    const clock = manualClock();
    const stalls: LoopStall[] = [];
    const meter = new EventLoopLagMeter(clock, new ActivityLedger(clock), DEFAULT_EVENT_LOOP_LAG_POLICY, stall =>
      stalls.push(stall),
    );

    // Act
    clock.advance(250);
    meter.tick();
    clock.advance(260);
    meter.tick();

    // Assert
    should(meter.view()).deepEqual({ lagMs: 10, maxLagMs: 10, stalls: 0 });
    should(stalls).deepEqual([]);
  });

  it('should report a late tick as a stall naming the work that ran during it', () => {
    // Arrange
    const clock = manualClock();
    const ledger = new ActivityLedger(clock);
    const stalls: LoopStall[] = [];
    const meter = new EventLoopLagMeter(clock, ledger, DEFAULT_EVENT_LOOP_LAG_POLICY, stall => stalls.push(stall));
    const end = ledger.begin('session listing');

    // Act — the loop could not run for six minutes, then the work ended before the tick fired.
    clock.advance(366_900);
    end();
    meter.tick();
    clock.advance(250);
    meter.tick();

    // Assert
    should(stalls).deepEqual([{ atMs: 1_366_900, durationMs: 366_650, during: ['session listing'] }]);
    should(meter.view()).deepEqual({
      lagMs: 0,
      maxLagMs: 366_650,
      stalls: 1,
      lastStall: { atMs: 1_366_900, durationMs: 366_650, during: ['session listing'] },
    });
  });
});

describe('stall and watchdog wording', () => {
  it('should say how long the loop stalled and what was running, or that nothing named was', () => {
    // Act / Assert
    should(
      describeLoopStall({ atMs: 0, durationMs: 2_345, during: ['boot: mounting subsystems', 'self-check'] }),
    ).equal('event loop stalled for 2.3s — during boot: mounting subsystems, self-check');
    should(describeLoopStall({ atMs: 0, durationMs: 600, during: [] })).equal(
      'event loop stalled for 0.6s — no named work was in flight',
    );
  });

  it('should name the silence and the suspects before ending the process', () => {
    // Act / Assert
    should(describeWatchdogFire(301_000, 'analytics rebuild')).equal(
      'watchdog: the event loop has not run for 301s (during analytics rebuild) — ending this process so its service manager starts a fresh one',
    );
    should(describeWatchdogFire(300_000, '')).containEql('(no named work was in flight)');
  });

  it('should fire only once the silence reaches a limit, and never when switched off', () => {
    // Act / Assert
    should(watchdogShouldFire(299_999, 300_000)).be.false();
    should(watchdogShouldFire(300_000, 300_000)).be.true();
    should(watchdogShouldFire(10_000_000, 0)).be.false();
  });

  it('should offer a watchdog that watches nothing', () => {
    // Act / Assert — both are no-ops; neither may throw.
    NO_WATCHDOG.beat(['anything']);
    NO_WATCHDOG.stop();
  });
});

describe('parseWatchdogLimit', () => {
  it('should default when unset, switch off at zero and read whole seconds', () => {
    // Act / Assert
    should(parseWatchdogLimit(undefined)).equal(DEFAULT_WATCHDOG_LIMIT_MS);
    should(parseWatchdogLimit('  ')).equal(DEFAULT_WATCHDOG_LIMIT_MS);
    should(parseWatchdogLimit('0')).equal(0);
    should(parseWatchdogLimit(' 45 ')).equal(45_000);
  });

  it('should refuse anything that is not a whole number of seconds, naming the variable', () => {
    // Act / Assert
    should(() => parseWatchdogLimit('5m')).throw(new RegExp(`^${WATCHDOG_VARIABLE} must be a whole number`, 'u'));
    should(() => parseWatchdogLimit('-1')).throw();
    should(() => parseWatchdogLimit('1.5')).throw();
  });
});
