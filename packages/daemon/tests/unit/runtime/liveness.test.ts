import { describe, it } from 'bun:test';
import should from 'should';
import { AsyncActivityScope } from '../../../src/adapters/runtime/stall-attribution.ts';
import {
  ActivityLedger,
  BootProgress,
  DEFAULT_EVENT_LOOP_LAG_POLICY,
  DEFAULT_WATCHDOG_LIMIT_MS,
  describeLoopStall,
  describeWatchdogFire,
  EventLoopLagMeter,
  FLAT_ACTIVITY_SCOPE,
  type LoopStall,
  NO_WATCHDOG,
  parseWatchdogLimit,
  type StackSample,
  summariseStacks,
  WATCHDOG_VARIABLE,
  watchdogShouldFire,
  watchdogSilenceFrom,
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

describe('ActivityLedger nesting', () => {
  it('should label work run inside another activity with its whole path, across awaits', async () => {
    // Arrange
    const clock = manualClock();
    const ledger = new ActivityLedger(clock, new AsyncActivityScope());
    let seen: readonly string[] = [];

    // Act
    await ledger.run('fleet refresh', async () => {
      await Promise.resolve();
      await ledger.run('runtime homes', async () => {
        await Bun.sleep(1);
        seen = ledger.inFlight();
      });
    });

    // Assert
    should(seen).deepEqual(['fleet refresh', 'fleet refresh › runtime homes']);
    should(ledger.inFlight()).deepEqual([]);
  });

  it('should keep only the deepest overlapping labels as the innermost', async () => {
    // Arrange
    const clock = manualClock();
    const ledger = new ActivityLedger(clock, new AsyncActivityScope());
    const endTurns = ledger.begin('turn watcher');
    clock.advance(1);

    // Act
    await ledger.run('fleet refresh', async () => {
      clock.advance(1);
      await ledger.run('usage feed', () => {
        clock.advance(1_000);
      });
    });
    endTurns();

    // Assert — the loop that only enclosed the step is not a suspect of its own; a sibling loop is.
    should(ledger.overlapping(1_000_002, 1_001_002)).deepEqual([
      'turn watcher',
      'fleet refresh',
      'fleet refresh › usage feed',
    ]);
    should(ledger.innermost(1_000_002, 1_001_002)).deepEqual(['turn watcher', 'fleet refresh › usage feed']);
  });

  it('should name an enclosing activity as innermost when its step ended before the window', async () => {
    // Arrange
    const clock = manualClock();
    const ledger = new ActivityLedger(clock, new AsyncActivityScope());

    // Act
    await ledger.run('analytics ingest', async () => {
      await ledger.run('discover', () => undefined);
      clock.advance(2_000);
    });

    // Assert
    should(ledger.innermost(1_001_000, 1_002_000)).deepEqual(['analytics ingest']);
  });

  it('should nest nothing without a scope, as a flat ledger always did', async () => {
    // Arrange
    const ledger = new ActivityLedger(manualClock(), FLAT_ACTIVITY_SCOPE);
    let seen: readonly string[] = [];

    // Act
    await ledger.run('outer', () =>
      ledger.run('inner', () => {
        seen = ledger.inFlight();
      }),
    );

    // Assert
    should(seen).deepEqual(['outer', 'inner']);
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

  it('should total the time the loop was blocked, a late tick that has not fired yet included', () => {
    // Arrange
    const clock = manualClock();
    const meter = new EventLoopLagMeter(clock, new ActivityLedger(clock), DEFAULT_EVENT_LOOP_LAG_POLICY, () => 0);

    // Act — one tick ten seconds late, one on time, then a stall still in progress.
    const before = meter.blockedMs();
    clock.advance(10_250);
    meter.tick();
    clock.advance(250);
    meter.tick();
    const fired = meter.blockedMs();
    clock.advance(4_250);
    const pending = meter.blockedMs();
    meter.tick();

    // Assert — the pending stall is counted once: no reading moves when its tick finally fires.
    should([before, fired, pending, meter.blockedMs()]).deepEqual([0, 10_000, 14_000, 14_000]);
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
    const stall = {
      atMs: 1_366_900,
      durationMs: 366_650,
      during: ['session listing'],
      innermost: ['session listing'],
      stacks: [],
    };
    should(stalls).deepEqual([stall]);
    should(meter.view()).deepEqual({ lagMs: 0, maxLagMs: 366_650, stalls: 1, lastStall: stall, worstStall: stall });
  });

  it('should call a tick a quarter second late a stall, and one just under it lag', () => {
    // Arrange
    const clock = manualClock();
    const stalls: LoopStall[] = [];
    const meter = new EventLoopLagMeter(clock, new ActivityLedger(clock), DEFAULT_EVENT_LOOP_LAG_POLICY, stall =>
      stalls.push(stall),
    );

    // Act
    clock.advance(499);
    meter.tick();
    clock.advance(500);
    meter.tick();

    // Assert
    should(stalls.map(stall => stall.durationMs)).deepEqual([250]);
  });

  it('should attribute a stall to the stacks sampled during it, and only those', () => {
    // Arrange
    const clock = manualClock();
    const ledger = new ActivityLedger(clock, new AsyncActivityScope());
    const batches: StackSample[][] = [
      [{ frames: [{ name: 'before' }] }],
      [
        { frames: [{ name: 'readFileSync' }, { name: 'scan', url: '/w/packages/fleet/src/homes.ts', line: 88 }] },
        { frames: [{ name: 'readFileSync' }, { name: 'scan', url: '/w/packages/fleet/src/homes.ts', line: 88 }] },
        { frames: [{ name: 'parse' }] },
      ],
    ];
    const sampler = { drain: () => batches.shift() ?? [], discard: () => void batches.shift() };
    const stalls: LoopStall[] = [];
    const meter = new EventLoopLagMeter(
      clock,
      ledger,
      DEFAULT_EVENT_LOOP_LAG_POLICY,
      stall => stalls.push(stall),
      sampler,
    );

    // Act — an on-time tick drains the first window's samples; the late one holds only its own.
    clock.advance(250);
    meter.tick();
    clock.advance(1_250);
    meter.tick();

    // Assert
    should(stalls).have.length(1);
    should(stalls[0]?.stacks).deepEqual([
      { stack: 'readFileSync ← scan (fleet/src/homes.ts:88)', share: 0.67 },
      { stack: 'parse', share: 0.33 },
    ]);
  });

  it('should empty the sampler on every tick but fold only the window of a late tick', () => {
    // Arrange — folding an on-time window into frames only to drop it was most of what attribution cost.
    const clock = manualClock();
    const calls: string[] = [];
    const sampler = {
      drain: () => {
        calls.push('drain');
        return [];
      },
      discard: () => void calls.push('discard'),
    };
    const meter = new EventLoopLagMeter(
      clock,
      new ActivityLedger(clock),
      DEFAULT_EVENT_LOOP_LAG_POLICY,
      () => undefined,
      sampler,
    );

    // Act
    clock.advance(250);
    meter.tick();
    clock.advance(260);
    meter.tick();
    clock.advance(900);
    meter.tick();

    // Assert
    should(calls).deepEqual(['discard', 'discard', 'drain']);
  });

  it('should keep the worst stall beside the last one', () => {
    // Arrange
    const clock = manualClock();
    const meter = new EventLoopLagMeter(
      clock,
      new ActivityLedger(clock),
      DEFAULT_EVENT_LOOP_LAG_POLICY,
      () => undefined,
    );

    // Act
    clock.advance(4_250);
    meter.tick();
    clock.advance(750);
    meter.tick();

    // Assert
    should(meter.view().worstStall?.durationMs).equal(4_000);
    should(meter.view().lastStall?.durationMs).equal(500);
  });
});

describe('summariseStacks', () => {
  it('should count each distinct innermost stack once per sample, hottest first, at most three', () => {
    // Arrange
    const sample = (...names: string[]): StackSample => ({ frames: names.map(name => ({ name })) });

    // Act
    const actual = summariseStacks([
      sample('a'),
      sample('b'),
      sample('b'),
      sample('c'),
      sample('c'),
      sample('c'),
      sample('d'),
      sample(),
    ]);

    // Assert — the empty sample names nothing and counts toward nothing.
    should(actual).deepEqual([
      { stack: 'c', share: 0.43 },
      { stack: 'b', share: 0.29 },
      { stack: 'a', share: 0.14 },
    ]);
  });

  it('should name a frame by its workspace path, its line when known, and an anonymous one as such', () => {
    // Act
    const actual = summariseStacks([
      {
        frames: [
          { name: '', url: '/$bunfs/root/packages/daemon/src/x.ts', line: 3 },
          { name: 'outer', url: '/elsewhere/y.ts' },
        ],
      },
    ]);

    // Assert
    should(actual).deepEqual([{ stack: '(anonymous) (daemon/src/x.ts:3) ← outer (/elsewhere/y.ts)', share: 1 }]);
  });

  it('should cut a stack to its six innermost frames so one hot loop is one place', () => {
    // Arrange
    const deep = (leaf: string): StackSample => ({
      frames: [leaf, 'f2', 'f3', 'f4', 'f5', 'f6', 'f7'].map(name => ({ name })),
    });

    // Act
    const actual = summariseStacks([deep('f1'), { frames: [...deep('f1').frames.slice(0, 6), { name: 'other' }] }]);

    // Assert
    should(actual).deepEqual([{ stack: 'f1 ← f2 ← f3 ← f4 ← f5 ← f6', share: 1 }]);
  });
});

describe('EventLoopLagMeter disk pressure', () => {
  const reading = (some: number, full: number) => ({
    some: { avg10: some, avg60: some, avg300: some },
    full: { avg10: full, avg60: full, avg300: full },
  });

  it('should blame the disk for a stall recorded while it was saturated, and say so in the view', () => {
    // Arrange
    const clock = manualClock();
    const stalls: LoopStall[] = [];
    const meter = new EventLoopLagMeter(
      clock,
      new ActivityLedger(clock),
      DEFAULT_EVENT_LOOP_LAG_POLICY,
      stall => stalls.push(stall),
      undefined,
      { current: () => reading(52, 46) },
    );

    // Act
    clock.advance(5_250);
    meter.tick();

    // Assert
    const io = { someAvg10: 52, fullAvg10: 46, saturated: true };
    should(stalls[0]?.cause).equal('disk');
    should(stalls[0]?.io).deepEqual(io);
    should(meter.view().io).deepEqual(io);
    should(describeLoopStall(stalls[0] as LoopStall)).endWith(
      ' — disk is saturated (io pressure 46% full) — the daemon is slow, not dead',
    );
  });

  it('should record the pressure but name no cause when the disk was calm', () => {
    // Arrange
    const clock = manualClock();
    const stalls: LoopStall[] = [];
    const meter = new EventLoopLagMeter(
      clock,
      new ActivityLedger(clock),
      DEFAULT_EVENT_LOOP_LAG_POLICY,
      stall => stalls.push(stall),
      undefined,
      { current: () => reading(1, 0) },
    );

    // Act
    clock.advance(5_250);
    meter.tick();

    // Assert
    should(stalls[0]).not.have.property('cause');
    should(stalls[0]?.io?.saturated).be.false();
    should(describeLoopStall(stalls[0] as LoopStall)).not.containEql('disk');
  });
});

describe('stall and watchdog wording', () => {
  it('should say how long the loop stalled and the innermost work, or that nothing named was', () => {
    // Act / Assert
    should(
      describeLoopStall({
        atMs: 0,
        durationMs: 2_345,
        during: ['boot: mounting subsystems', 'fleet refresh', 'fleet refresh › usage feed'],
        innermost: ['boot: mounting subsystems', 'fleet refresh › usage feed'],
        stacks: [],
      }),
    ).equal('event loop stalled for 2.3s — during boot: mounting subsystems, fleet refresh › usage feed');
    should(describeLoopStall({ atMs: 0, durationMs: 600, during: [], innermost: [], stacks: [] })).equal(
      'event loop stalled for 0.6s — no named work was in flight',
    );
  });

  it('should say where the hottest sampled stack spent the stall', () => {
    // Act / Assert
    should(
      describeLoopStall({
        atMs: 0,
        durationMs: 1_300,
        during: ['analytics ingest'],
        innermost: ['analytics ingest'],
        stacks: [{ stack: 'JSON.parse ← fold (daemon/src/lib/analytics/x.ts:9)', share: 0.8 }],
      }),
    ).equal(
      'event loop stalled for 1.3s — during analytics ingest — 80% in JSON.parse ← fold (daemon/src/lib/analytics/x.ts:9)',
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

  it('should measure a stuck loop from its last heartbeat while the watchdog itself ran on time', () => {
    // Arrange — the thread checked a second ago; the loop last beat six minutes ago.
    const now = 10_000_000;

    // Act
    const from = watchdogSilenceFrom(now - 360_000, now, now - 1_000, 0, 1_000);

    // Assert
    should(from).equal(now - 360_000);
    should(watchdogShouldFire(now - from, 300_000)).be.true();
  });

  it('should restart the silence when the whole process was suspended, as a sleeping Mac is', () => {
    // Arrange — the lid was closed for an hour: the thread's own previous check is an hour old too.
    const now = 10_000_000;

    // Act
    const from = watchdogSilenceFrom(now - 3_600_000, now, now - 3_600_000, 0, 1_000);

    // Assert — not fired on waking, and a loop that stays stuck is still caught one limit later.
    should(from).equal(now);
    should(watchdogShouldFire(now - from, 300_000)).be.false();
    const later = watchdogSilenceFrom(now - 3_600_000, now + 300_000, now + 299_000, from, 1_000);
    should(watchdogShouldFire(now + 300_000 - later, 300_000)).be.true();
  });

  it('should measure from a heartbeat that arrived after the process resumed', () => {
    // Act
    const from = watchdogSilenceFrom(5_000, 6_000, 5_500, 4_000, 1_000);

    // Assert
    should(from).equal(5_000);
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
