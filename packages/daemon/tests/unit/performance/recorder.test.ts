import { describe, it, spyOn } from 'bun:test';
import should from 'should';
import {
  NO_PERFORMANCE_PROBE,
  PerformanceRecorder,
  PerformanceWindow,
  REPORT_TOP,
} from '../../../src/lib/performance/recorder.ts';
import type { LoopStall, StackSample } from '../../../src/lib/runtime/liveness.ts';

/** Long enough that the rates below come out as plain numbers: 100 s. */
const WINDOW_MS = 100_000;

const stall = (durationMs: number, atMs: number): LoopStall => ({
  atMs,
  durationMs,
  during: ['loop', 'step'],
  innermost: ['step'],
  stacks: [{ stack: 'hot ← caller', share: 0.5 }],
});

const A_TS = 'file:///repo/packages/daemon/src/a.ts';
const B_TS = 'file:///repo/packages/daemon/src/b.ts';

describe('PerformanceWindow tables', () => {
  it('should be empty for a window nothing happened in', () => {
    // Arrange
    const subject = new PerformanceWindow(0);

    // Act
    const actual = subject.tables(WINDOW_MS);

    // Assert
    should(actual.activities).deepEqual([]);
    should(actual.routes).deepEqual([]);
    should(actual.workers).deepEqual([]);
    should(actual.childProcesses).deepEqual({ total: 0, perMinute: 0, commands: [] });
    should(actual.fileOperations).deepEqual({ total: 0, perSecond: 0, top: [] });
    should(actual.cpuProfile).deepEqual({ samples: 0, self: [], inclusive: [], stacks: [] });
    should(actual.eventLoop).deepEqual({
      ticks: 0,
      lag: { p50Ms: 0, p95Ms: 0, maxMs: 0 },
      blocksOver100Ms: 0,
      blocksOver250Ms: 0,
      blockedMs: 0,
      stalls: [],
    });
  });

  it('should rank activities by total wall time and rate them per minute', () => {
    // Arrange
    const subject = new PerformanceWindow(0);
    subject.activity('quick', 100);
    subject.activity('quick', 200);
    subject.activity('slow', 500);

    // Act
    const actual = subject.tables(WINDOW_MS).activities;

    // Assert
    should(actual).deepEqual([
      { name: 'slow', count: 1, perMinute: 0.6, wall: { totalMs: 500, p50Ms: 500, p95Ms: 500, maxMs: 500 } },
      { name: 'quick', count: 2, perMinute: 1.2, wall: { totalMs: 300, p50Ms: 100, p95Ms: 200, maxMs: 200 } },
    ]);
  });

  it('should rank routes by total wall time, counting errors and bytes', () => {
    // Arrange
    const subject = new PerformanceWindow(0);
    subject.route('GET /x', 10, 200, 100);
    subject.route('GET /x', 30, 500, 300);
    subject.route('POST /y', 100, 201, 5);

    // Act
    const actual = subject.tables(WINDOW_MS).routes;

    // Assert
    should(actual).deepEqual([
      {
        route: 'POST /y',
        count: 1,
        perMinute: 0.6,
        errors: 0,
        wall: { totalMs: 100, p50Ms: 100, p95Ms: 100, maxMs: 100 },
        bytes: { total: 5, max: 5 },
      },
      {
        route: 'GET /x',
        count: 2,
        perMinute: 1.2,
        errors: 1,
        wall: { totalMs: 40, p50Ms: 10, p95Ms: 30, maxMs: 30 },
        bytes: { total: 400, max: 300 },
      },
    ]);
  });

  it('should count a 400 as an error and a 399 as none', () => {
    // Arrange
    const subject = new PerformanceWindow(0);
    subject.route('GET /edge', 1, 399, 0);
    subject.route('GET /edge', 1, 400, 0);

    // Act
    const actual = subject.tables(WINDOW_MS).routes[0]?.errors;

    // Assert
    should(actual).equal(1);
  });

  it('should rank child processes by how often they started, count the synchronous ones, and name who started them', () => {
    // Arrange
    const subject = new PerformanceWindow(0);
    subject.childStarted('git', false, 'fleet refresh');
    subject.childStarted('git', true);
    for (let index = 0; index < 3; index += 1) subject.childStarted('tmux', false, 'turn watcher');
    subject.childExited('git', 5);
    subject.childExited('ps', 8);

    // Act
    const actual = subject.tables(WINDOW_MS).childProcesses;

    // Assert
    should(actual).deepEqual({
      total: 5,
      perMinute: 3,
      commands: [
        {
          command: 'tmux',
          count: 3,
          perMinute: 1.8,
          synchronous: 0,
          wall: { totalMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
          by: [{ activity: 'turn watcher', count: 3 }],
        },
        {
          command: 'git',
          count: 2,
          perMinute: 1.2,
          synchronous: 1,
          wall: { totalMs: 5, p50Ms: 5, p95Ms: 5, maxMs: 5 },
          by: [
            { activity: '(no named work)', count: 1 },
            { activity: 'fleet refresh', count: 1 },
          ],
        },
        {
          command: 'ps',
          count: 0,
          perMinute: 0,
          synchronous: 0,
          wall: { totalMs: 8, p50Ms: 8, p95Ms: 8, maxMs: 8 },
          by: [],
        },
      ],
    });
  });

  it('should name at most the three busiest starters of a command, busiest first', () => {
    // Arrange
    const subject = new PerformanceWindow(0);
    for (const [activity, times] of [
      ['self-check', 1],
      ['turn watcher', 4],
      ['warden', 2],
      ['live readout', 2],
    ] as const)
      for (let index = 0; index < times; index += 1) subject.childStarted('tmux', false, activity);

    // Act
    const actual = subject.tables(WINDOW_MS).childProcesses.commands[0]?.by;

    // Assert
    should(actual).deepEqual([
      { activity: 'turn watcher', count: 4 },
      { activity: 'live readout', count: 2 },
      { activity: 'warden', count: 2 },
    ]);
  });

  it('should rank file operations by count and split each key into operation and path', () => {
    // Arrange
    const subject = new PerformanceWindow(0);
    subject.fileOperation('read', '/a', 1);
    subject.fileOperation('read', '/a', 3);
    for (let index = 0; index < 3; index += 1) subject.fileOperation('stat', '/b', 2);

    // Act
    const actual = subject.tables(WINDOW_MS).fileOperations;

    // Assert
    should(actual).deepEqual({
      total: 5,
      perSecond: 0.05,
      top: [
        {
          operation: 'stat',
          path: '/b',
          count: 3,
          perSecond: 0.03,
          wall: { totalMs: 6, p50Ms: 2, p95Ms: 2, maxMs: 2 },
        },
        {
          operation: 'read',
          path: '/a',
          count: 2,
          perSecond: 0.02,
          wall: { totalMs: 4, p50Ms: 1, p95Ms: 3, maxMs: 3 },
        },
      ],
    });
  });

  it('should keep only the top rows of a table', () => {
    // Arrange
    const subject = new PerformanceWindow(0);
    for (let index = 0; index < REPORT_TOP + 5; index += 1) subject.activity(`activity-${String(index)}`, index + 1);

    // Act
    const actual = subject.tables(WINDOW_MS).activities;

    // Assert
    should(actual).have.length(REPORT_TOP);
    should(actual[0]?.name).equal(`activity-${String(REPORT_TOP + 4)}`);
  });

  it('should count loop ticks and blocks at the 100 ms and 250 ms thresholds', () => {
    // Arrange
    const subject = new PerformanceWindow(0);
    for (const lag of [10, 99, 100, 249, 250, 400]) subject.loopTick(lag);

    // Act
    const actual = subject.tables(WINDOW_MS).eventLoop;

    // Assert
    should(actual.ticks).equal(6);
    should(actual.lag).deepEqual({ p50Ms: 100, p95Ms: 400, maxMs: 400 });
    should(actual.blocksOver100Ms).equal(4);
    should(actual.blocksOver250Ms).equal(2);
    should(actual.blockedMs).equal(999);
  });

  it('should report the ten longest stalls, longest first, offset from the window start', () => {
    // Arrange
    const subject = new PerformanceWindow(1_000);
    for (let index = 1; index <= 12; index += 1) subject.stall(stall(index * 10 + 0.123, 1_000 + index * 5));
    subject.stall(stall(500.456, 900));

    // Act
    const actual = subject.tables(WINDOW_MS).eventLoop.stalls;

    // Assert
    should(actual).have.length(10);
    should(actual.map(entry => entry.durationMs)).deepEqual([
      500.46, 120.12, 110.12, 100.12, 90.12, 80.12, 70.12, 60.12, 50.12, 40.12,
    ]);
    should(actual[0]).deepEqual({
      atOffsetMs: 0,
      durationMs: 500.46,
      during: ['step'],
      stacks: [{ stack: 'hot ← caller', share: 0.5 }],
    });
    should(actual[1]?.atOffsetMs).equal(60);
  });

  it('should fold samples into self, inclusive and stack tables', () => {
    // Arrange
    const subject = new PerformanceWindow(0);
    const readFile = { name: 'readFile', url: A_TS, line: 10 };
    const scan = { name: 'scan', url: B_TS, line: 20 };
    const deep = Array.from({ length: 10 }, (_, index) => ({ name: `d${String(index)}` }));
    const samples: StackSample[] = [
      { frames: [readFile, scan] },
      { frames: [readFile, scan] },
      { frames: [readFile, { name: 'main' }] },
      { frames: [] },
      { frames: [{ name: 'f' }, { name: 'g' }, { name: 'f' }] },
      { frames: deep },
    ];
    subject.samples(samples);

    // Act
    const actual = subject.tables(WINDOW_MS).cpuProfile;

    // Assert
    should(actual.samples).equal(5);
    should(actual.self).deepEqual([
      { frame: 'readFile (daemon/src/a.ts:10)', samples: 3, share: 0.6 },
      { frame: 'd0', samples: 1, share: 0.2 },
      { frame: 'f', samples: 1, share: 0.2 },
    ]);
    should(actual.inclusive.slice(0, 2)).deepEqual([
      { frame: 'readFile (daemon/src/a.ts:10)', samples: 3, share: 0.6 },
      { frame: 'scan (daemon/src/b.ts:20)', samples: 2, share: 0.4 },
    ]);
    should(actual.inclusive.find(entry => entry.frame === 'f')?.samples).equal(1);
    should(actual.stacks).deepEqual([
      { stack: 'readFile (daemon/src/a.ts:10) ← scan (daemon/src/b.ts:20)', samples: 2, share: 0.4 },
      { stack: 'd0 ← d1 ← d2 ← d3 ← d4 ← d5 ← d6 ← d7', samples: 1, share: 0.2 },
      { stack: 'f ← g ← f', samples: 1, share: 0.2 },
      { stack: 'readFile (daemon/src/a.ts:10) ← main', samples: 1, share: 0.2 },
    ]);
  });

  it('should report each worker pool alphabetically with its in-flight gauge', () => {
    // Arrange
    const subject = new PerformanceWindow(0);
    subject.worker('b', 1);
    subject.worker('b', 3);
    subject.worker('a', 2);

    // Act
    const actual = subject.tables(WINDOW_MS).workers;

    // Assert
    should(actual).deepEqual([
      { name: 'a', inFlight: { min: 2, mean: 2, max: 2 } },
      { name: 'b', inFlight: { min: 1, mean: 2, max: 3 } },
    ]);
  });

  it('should account each worker job as its worker reported it, beside the in-flight gauge', () => {
    // Arrange
    const subject = new PerformanceWindow(0);
    subject.worker('housekeeping', 1);
    subject.workerJob(
      'housekeeping',
      {
        wallMs: 30,
        children: [{ command: 'security find-generic-password', wallMs: 20 }],
        fileReads: 1,
        fetches: 1,
        heapBytes: 1_048_576,
      },
      'fleet refresh',
    );
    subject.workerJob('housekeeping', { wallMs: 10, children: [], fileReads: 2, fetches: 0, heapBytes: 3_145_728 });
    subject.workerJob('folds', { wallMs: 5, children: [], fileReads: 0, fetches: 0, heapBytes: 0 });

    // Act
    const actual = subject.tables(WINDOW_MS).workers;

    // Assert — a worker that only reported work still has a (zero) gauge.
    should(actual).deepEqual([
      {
        name: 'folds',
        inFlight: { min: 0, mean: 0, max: 0 },
        work: {
          jobs: 1,
          perMinute: 0.6,
          wall: { totalMs: 5, p50Ms: 5, p95Ms: 5, maxMs: 5 },
          childProcesses: [],
          fileReads: 0,
          fetches: 0,
          heapMb: { min: 0, mean: 0, max: 0 },
        },
      },
      {
        name: 'housekeeping',
        inFlight: { min: 1, mean: 1, max: 1 },
        work: {
          jobs: 2,
          perMinute: 1.2,
          wall: { totalMs: 40, p50Ms: 10, p95Ms: 30, maxMs: 30 },
          childProcesses: [
            {
              command: 'security find-generic-password',
              count: 1,
              perMinute: 0.6,
              synchronous: 0,
              wall: { totalMs: 20, p50Ms: 20, p95Ms: 20, maxMs: 20 },
              by: [{ activity: 'fleet refresh', count: 1 }],
            },
          ],
          fileReads: 3,
          fetches: 1,
          heapMb: { min: 1, mean: 2, max: 3 },
        },
      },
    ]);
  });
});

describe('PerformanceRecorder', () => {
  it('should not be recording until a window is open, nor after the last one closes', () => {
    // Arrange
    const subject = new PerformanceRecorder();

    // Act
    const before = subject.recording;
    const first = subject.open(0);
    const second = subject.open(0);
    subject.close(first);
    const whileOpen = subject.recording;
    subject.close(second);
    const after = subject.recording;

    // Assert
    should([before, whileOpen, after]).deepEqual([false, true, false]);
  });

  it('should hand every event to each open window and to none that was closed', () => {
    // Arrange
    const subject = new PerformanceRecorder();
    const kept = subject.open(0);
    const closed = subject.open(0);
    const mirror = new PerformanceWindow(0);
    const sample: StackSample = { frames: [{ name: 'work', url: A_TS, line: 1 }] };
    const emitInto = (target: { [K in keyof typeof NO_PERFORMANCE_PROBE]: unknown }) => {
      const probe = target as typeof NO_PERFORMANCE_PROBE;
      probe.activity('act', 5);
      probe.route('GET /r', 7, 500, 9);
      probe.childStarted('git', true);
      probe.childExited('git', 4);
      probe.fileOperation('read', '/f', 2);
      probe.loopTick(150);
      probe.stall(stall(150, 10));
      probe.samples([sample]);
      probe.workerJob('w', { wallMs: 3, children: [], fileReads: 1, fetches: 0, heapBytes: 0 }, 'act');
    };

    // Act
    subject.close(closed);
    emitInto(subject as never);
    emitInto(mirror as never);

    // Assert
    should(kept.tables(WINDOW_MS)).deepEqual(mirror.tables(WINDOW_MS));
    should(closed.tables(WINDOW_MS).activities).deepEqual([]);
    should(kept.tables(WINDOW_MS).routes).have.length(1);
  });

  it('should deliver one event to several open windows', () => {
    // Arrange
    const subject = new PerformanceRecorder();
    const windows = [subject.open(0), subject.open(0)];

    // Act
    subject.activity('shared', 10);

    // Assert
    should(windows.map(window => window.tables(WINDOW_MS).activities[0]?.name)).deepEqual(['shared', 'shared']);
  });

  it('should not wake a window for an empty batch of samples', () => {
    // Arrange
    const subject = new PerformanceRecorder();
    const window = subject.open(0);
    const spy = spyOn(window, 'samples');

    // Act
    subject.samples([]);
    const afterEmpty = spy.mock.calls.length;
    subject.samples([{ frames: [{ name: 'x' }] }]);

    // Assert
    should(afterEmpty).equal(0);
    should(spy.mock.calls.length).equal(1);
  });
});

describe('NO_PERFORMANCE_PROBE', () => {
  it('should never be recording and should ignore every event', () => {
    // Arrange
    const subject = NO_PERFORMANCE_PROBE;

    // Act
    const actual = [
      subject.activity('a', 1),
      subject.route('r', 1, 200, 1),
      subject.childStarted('c', false),
      subject.childExited('c', 1),
      subject.fileOperation('o', 'p', 1),
      subject.loopTick(1),
      subject.stall(stall(1, 1)),
      subject.samples([]),
      subject.workerJob('w', { wallMs: 1, children: [], fileReads: 0, fetches: 0, heapBytes: 0 }),
    ];

    // Assert
    should(subject.recording).be.false();
    should(actual.every(value => value === undefined)).be.true();
    should(Object.isFrozen(subject)).be.true();
  });
});
