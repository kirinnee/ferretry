import { describe, it } from 'bun:test';
import { PERFORMANCE_REPORT_VERSION, type PerformanceReport } from '@ferretry/protocol';
import should from 'should';
import type { PerformanceBudget } from '../../../src/lib/performance/budgets.ts';
import {
  PerformanceProfiler,
  type ProcessReading,
  type ProfileContextPort,
  sampledShareLimitation,
  sampleIntervalMs,
} from '../../../src/lib/performance/profiler.ts';
import { PerformanceRecorder } from '../../../src/lib/performance/recorder.ts';

const MB = 1_048_576;
const START_MS = Date.parse('2024-05-01T10:00:00.000Z');

/** Lets every pending promise run. */
const flush = async () => {
  for (let round = 0; round < 20; round += 1) await Promise.resolve();
};

function reading(overrides: Partial<ProcessReading> = {}): ProcessReading {
  return {
    cpuUserMicros: 0,
    cpuSystemMicros: 0,
    rssBytes: 100 * MB,
    heapUsedBytes: 20 * MB,
    externalBytes: 5 * MB,
    voluntaryContextSwitches: 0,
    involuntaryContextSwitches: 0,
    ...overrides,
  };
}

type Step = ProcessReading | Error;

/** Timers a test fires by hand, so no time passes. */
class ManualTimers {
  readonly intervals: { intervalMs: number; tick: () => void; cancelled: boolean }[] = [];
  readonly delays: { delayMs: number; fire: () => void; cancelled: boolean }[] = [];

  every(intervalMs: number, tick: () => void): () => void {
    const entry = { intervalMs, tick, cancelled: false };
    this.intervals.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  after(delayMs: number, fire: () => void): () => void {
    const entry = { delayMs, fire, cancelled: false };
    this.delays.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  /** The most recent window's end, as the timer port received it. */
  elapse(): void {
    this.delays.at(-1)?.fire();
  }
}

interface World {
  readonly timers: ManualTimers;
  readonly recorder: PerformanceRecorder;
  readonly reads: { count: number };
  readonly queue: Step[];
  readonly clock: { value: number };
  readonly ids: string[];
  readonly subject: PerformanceProfiler;
}

function world(
  options: {
    readonly steps?: readonly Step[];
    readonly workers?: { name: string; inFlight: () => number }[];
    readonly fleet?: ProfileContextPort['fleet'];
    readonly budgets?: readonly PerformanceBudget[];
    readonly sessionWorkers?: ProfileContextPort['sessionWorkers'];
  } = {},
): World {
  const timers = new ManualTimers();
  const recorder = new PerformanceRecorder();
  const reads = { count: 0 };
  const queue: Step[] = [...(options.steps ?? [])];
  const clock = { value: START_MS };
  const ids: string[] = [];
  const subject = new PerformanceProfiler({
    recorder,
    gauges: {
      read: async () => {
        reads.count += 1;
        const step = queue.shift() ?? reading();
        if (step instanceof Error) throw step;
        return step;
      },
    },
    workers: options.workers ?? [],
    clock: { now: () => clock.value },
    timers,
    context: {
      daemon: { version: '1.2.3', platform: 'linux', arch: 'x64', runtime: 'bun 1.3' },
      uptimeSeconds: () => 3600.4,
      fleet: options.fleet ?? (async () => ({ sessions: 36, running: 5 })),
      limitations: () => ['no kernel tracing'],
      ...(options.sessionWorkers === undefined ? {} : { sessionWorkers: options.sessionWorkers }),
    },
    budgets: options.budgets ?? [],
    newId: () => {
      const id = `p${ids.length + 1}`;
      ids.push(id);
      return id;
    },
  });
  return { timers, recorder, reads, queue, clock, ids, subject };
}

/** Starts a profile, lets the first read land, then ends the window the way the clock would. */
async function finish(w: World, seconds = 30, elapsedMs = seconds * 1_000): Promise<PerformanceReport> {
  const pending = w.subject.run(seconds);
  await flush();
  w.clock.value += elapsedMs;
  w.timers.elapse();
  return await pending;
}

describe('PerformanceProfiler', () => {
  it('should turn two readings and a window into a report', async () => {
    // Arrange
    const subject = world({
      steps: [
        reading({
          cpuUserMicros: 1_000_000,
          cpuSystemMicros: 500_000,
          voluntaryContextSwitches: 10,
          involuntaryContextSwitches: 2,
          syscalls: { reads: 100, writes: 50 },
          childrenCpuMs: 200,
        }),
        reading({
          cpuUserMicros: 4_000_000,
          cpuSystemMicros: 1_500_000,
          rssBytes: 200 * MB,
          heapUsedBytes: 40 * MB,
          externalBytes: 15 * MB,
          voluntaryContextSwitches: 110,
          involuntaryContextSwitches: 7,
          syscalls: { reads: 700, writes: 350 },
          childrenCpuMs: 1_200,
        }),
      ],
    });

    // Act
    const actual = await finish(subject, 30);

    // Assert
    should(actual.version).equal(PERFORMANCE_REPORT_VERSION);
    should(actual.startedAt).equal('2024-05-01T10:00:00.000Z');
    should(actual.endedAt).equal('2024-05-01T10:00:30.000Z');
    should(actual.windowMs).equal(30_000);
    should(actual.daemon).deepEqual({
      version: '1.2.3',
      platform: 'linux',
      arch: 'x64',
      runtime: 'bun 1.3',
      uptimeSeconds: 3600,
    });
    should(actual.fleet).deepEqual({ sessions: 36, running: 5 });
    should(actual.limitations).deepEqual(['no kernel tracing']);
    should(actual.resources.cpu).deepEqual({ userMs: 3000, systemMs: 1000, percentOfCore: 13.33, childrenMs: 1000 });
    should(actual.resources.memory.rssMb).deepEqual({ min: 100, mean: 150, max: 200 });
    should(actual.resources.memory.heapUsedMb).deepEqual({ min: 20, mean: 30, max: 40 });
    should(actual.resources.memory.externalMb).deepEqual({ min: 5, mean: 10, max: 15 });
    should(actual.resources.syscalls).deepEqual({ reads: 600, writes: 300, perSecond: 30 });
    should(actual.resources.contextSwitches).deepEqual({ voluntary: 100, involuntary: 5 });
  });

  it.each([
    ['neither reading reports syscalls or children', reading(), reading()],
    ['only the first reports them', reading({ syscalls: { reads: 1, writes: 1 }, childrenCpuMs: 1 }), reading()],
    ['only the last reports them', reading(), reading({ syscalls: { reads: 1, writes: 1 }, childrenCpuMs: 1 })],
  ])('should leave out syscalls and children when %s', async (_name, first, last) => {
    // Arrange
    const subject = world({ steps: [first, last] });

    // Act
    const actual = await finish(subject);

    // Assert
    should(actual.resources).not.have.property('syscalls');
    should(actual.resources.cpu).not.have.property('childrenMs');
  });

  it('should never report a counter that went backwards as negative', async () => {
    // Arrange
    const subject = world({
      steps: [
        reading({
          cpuUserMicros: 9_000,
          cpuSystemMicros: 9_000,
          voluntaryContextSwitches: 9,
          involuntaryContextSwitches: 9,
          syscalls: { reads: 9, writes: 9 },
          childrenCpuMs: 9,
        }),
        reading({ syscalls: { reads: 1, writes: 1 }, childrenCpuMs: 1 }),
      ],
    });

    // Act
    const actual = await finish(subject);

    // Assert
    should(actual.resources.cpu).deepEqual({ userMs: 0, systemMs: 0, percentOfCore: 0, childrenMs: 0 });
    should(actual.resources.syscalls).deepEqual({ reads: 0, writes: 0, perSecond: 0 });
    should(actual.resources.contextSwitches).deepEqual({ voluntary: 0, involuntary: 0 });
  });

  it('should hold the window to at least one millisecond', async () => {
    // Arrange
    const subject = world();

    // Act
    const actual = await finish(subject, 5, 0);

    // Assert
    should(actual.windowMs).equal(1);
  });

  it('should record each worker queue on every reading', async () => {
    // Arrange
    const depths = [3, 1, 2];
    const subject = world({
      workers: [
        { name: 'transcripts', inFlight: () => depths.shift() ?? 0 },
        { name: 'analytics', inFlight: () => 0 },
      ],
    });

    // Act
    const pending = subject.subject.run(5);
    await flush();
    subject.timers.intervals[0]?.tick();
    await flush();
    subject.clock.value += 5_000;
    subject.timers.elapse();
    const actual = await pending;

    // Assert
    should(actual.workers.map(worker => worker.name)).deepEqual(['analytics', 'transcripts']);
    should(actual.workers.find(worker => worker.name === 'transcripts')?.inFlight.max).equal(3);
  });

  it('should read the gauges every second and stop when the window closes', async () => {
    // Arrange
    const subject = world({
      steps: [reading(), reading({ rssBytes: 300 * MB }), reading({ rssBytes: 100 * MB })],
    });

    // Act
    const pending = subject.subject.run(10);
    await flush();
    subject.timers.intervals[0]?.tick();
    await flush();
    subject.timers.elapse();
    const actual = await pending;

    // Assert
    should(subject.timers.intervals.map(entry => entry.intervalMs)).deepEqual([1_000]);
    should(subject.timers.delays.map(entry => entry.delayMs)).deepEqual([10_000]);
    should(subject.timers.intervals[0]?.cancelled).be.true();
    should(actual.resources.memory.rssMb.max).equal(300);
  });

  it('should swallow a reading that fails in the middle of the window', async () => {
    // Arrange
    const subject = world({ steps: [reading(), new Error('procfs went away'), reading({ rssBytes: 120 * MB })] });

    // Act
    const pending = subject.subject.run(5);
    await flush();
    subject.timers.intervals[0]?.tick();
    await flush();
    subject.timers.elapse();
    const actual = await pending;

    // Assert
    should(actual.resources.memory.rssMb).deepEqual({ min: 100, mean: 110, max: 120 });
  });

  it('should join the profile already running instead of starting another', () => {
    // Arrange
    const subject = world();

    // Act
    const first = subject.subject.start(30);
    const second = subject.subject.start(5);

    // Assert
    should(second).deepEqual(first);
    should(first).deepEqual({
      state: 'running',
      id: 'p1',
      startedAt: '2024-05-01T10:00:00.000Z',
      endsAt: '2024-05-01T10:00:30.000Z',
    });
    should(subject.ids).deepEqual(['p1']);
    should(subject.recorder.recording).be.true();
  });

  it('should answer a run() asked while one is running with the same report', async () => {
    // Arrange
    const subject = world();
    subject.subject.start(5);
    await flush();

    // Act
    const pending = subject.subject.run(99);
    subject.clock.value += 5_000;
    subject.timers.elapse();
    const actual = await pending;

    // Assert
    should(actual.windowMs).equal(5_000);
    should(subject.ids).deepEqual(['p1']);
  });

  it('should report a profile as running, then finished, and an unknown id as nothing', async () => {
    // Arrange
    const subject = world();
    const started = subject.subject.start(5);
    await flush();

    // Act
    const whileRunning = subject.subject.view('p1');
    subject.clock.value += 5_000;
    subject.timers.elapse();
    await flush();
    const afterwards = subject.subject.view('p1');
    const unknown = subject.subject.view('nope');

    // Assert
    should(whileRunning).deepEqual(started);
    should(afterwards?.state).equal('finished');
    should(afterwards?.id).equal('p1');
    should(afterwards && 'report' in afterwards ? afterwards.report.windowMs : undefined).equal(5_000);
    should(unknown).be.undefined();
    should(subject.recorder.recording).be.false();
  });

  it('should keep only the three most recent finished reports', async () => {
    // Arrange
    const subject = world();

    // Act
    for (let round = 0; round < 4; round += 1) await finish(subject, 5);
    const actual = ['p1', 'p2', 'p3', 'p4'].map(id => subject.subject.view(id)?.state);

    // Assert
    should(actual).deepEqual([undefined, 'finished', 'finished', 'finished']);
  });

  it('should clear a profile whose first reading fails so the next can begin', async () => {
    // Arrange
    const subject = world({ steps: [new Error('no procfs')] });
    const failing = subject.subject.run(5);

    // Act
    const error = await failing.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    await flush();
    const afterFailure = subject.subject.view('p1');
    const recordingAfter = subject.recorder.recording;
    const next = subject.subject.start(5);

    // Assert
    should((error as Error).message).equal('no procfs');
    should(afterFailure).be.undefined();
    should(recordingAfter).be.false();
    should(next.id).equal('p2');
  });

  it.each([
    ['rejects', async () => Promise.reject(new Error('index unreadable'))],
    ['has nothing to say', async () => undefined],
  ])('should leave the fleet out when it %s', async (_name, fleet) => {
    // Arrange
    const subject = world({ fleet });

    // Act
    const actual = await finish(subject);

    // Assert
    should(actual).not.have.property('fleet');
  });

  it('should judge the budgets it was given against the finished report', async () => {
    // Arrange
    const budgets: PerformanceBudget[] = [
      { name: 'daemon CPU', unit: '% of one core', limit: 5, measure: report => report.resources.cpu.percentOfCore },
      { name: 'window', unit: 'ms', limit: 60_000, measure: report => report.resources.cpu.userMs + 1 },
      { name: 'unseen', unit: 'ms', limit: 1, measure: () => undefined },
    ];
    const subject = world({
      budgets,
      steps: [reading(), reading({ cpuUserMicros: 3_000_000 })],
    });

    // Act
    const actual = await finish(subject, 30);

    // Assert
    should(actual.budgets).deepEqual([
      { name: 'daemon CPU', unit: '% of one core', limit: 5, actual: 10, ok: false },
      { name: 'window', unit: 'ms', limit: 60_000, actual: 3001, ok: true },
    ]);
  });
});

describe('sampledShareLimitation', () => {
  it.each([
    [0, 1_000, undefined],
    [100, 0, undefined],
    [600, 1_000, undefined],
    [
      550,
      6_000,
      'The sampled stacks cover about 550 ms of main-thread JavaScript, 9% of the daemon’s 6000 ms of CPU; the rest is native work they cannot see — the I/O thread pool, the kernel, garbage collection, starting child processes.',
    ],
  ])('should say how much of %s samples over %s ms of CPU the stacks explain', (samples, cpuMs, expected) => {
    // Act
    const actual = sampledShareLimitation(samples, cpuMs);

    // Assert
    should(actual).equal(expected);
  });
});

describe('sampleIntervalMs', () => {
  it.each([
    [undefined, 1],
    ['', 1],
    ['abc', 1],
    ['0', 1],
    ['-5', 1],
    ['1000', 1],
    [' 10000 ', 10],
  ])('should read %j microseconds as %s ms', (input, expected) => {
    // Act + Assert
    should(sampleIntervalMs(input)).equal(expected);
  });

  it('should count each sample as one interval of JavaScript', () => {
    // Act
    const actual = sampledShareLimitation(100, 6_000, 10);

    // Assert
    should(actual).startWith('The sampled stacks cover about 1000 ms of main-thread JavaScript, 17% of');
  });
});

describe('PerformanceProfiler and the session-worker pool', () => {
  it('should carry the pool as the window ends, and leave it out where the daemon has none', async () => {
    // Arrange
    const pool = { enabled: true, max: 2, threads: 1, sessionsPerThread: [5] };
    const pooled = world({ sessionWorkers: () => pool });
    const without = world();

    // Act
    const [withPool, withoutPool] = [await finish(pooled), await finish(without)];

    // Assert
    should(withPool.sessionWorkers).deepEqual(pool);
    should(withoutPool).not.have.property('sessionWorkers');
  });
});
