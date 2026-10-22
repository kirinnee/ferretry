import { describe, it } from 'bun:test';
import should from 'should';
import type { PerformanceReport } from '../../src/lib/performance.ts';
import { describeSessionWorkerPool, renderPerformanceReport } from '../../src/lib/performance-render.ts';
import { fullReport, minimalReport, wallStats } from '../performance-report-fixtures.ts';

describe('renderPerformanceReport', () => {
  it('should lay out every section of a full report', () => {
    // Arrange
    const input = fullReport();

    // Act
    const actual = renderPerformanceReport(input);

    // Assert
    should(actual).containEql('Daemon profile — 30 s · 1.2.3 on linux/x64 (bun 1.3) · up 90.0 s');
    should(actual).containEql('Fleet: 36 sessions, 4 running');
    should(actual).containEql('Budgets (an idle daemon)');
    should(actual).containEql('CPU      12.3% of one core · user 1.5 s · system 251 ms · children 800 ms');
    should(actual).containEql('Memory   rss 120.3 MB (max 140) · heap 60 MB · external 6 MB');
    should(actual).containEql('Syscalls 50/s read+write (1,200 reads, 300 writes)');
    should(actual).containEql('Switches 1,000 voluntary · 20 involuntary');
    should(actual).containEql('2 blocks over 100 ms (1 over 250 ms), 900 ms blocked');
    should(actual).containEql('400 ms at +2.0 s during sessions.scan, index.rebuild — 75% in scan < walk');
    should(actual).containEql('120 ms at +5.0 s during no named work');
    should(actual).containEql('Hot functions — self time, of 1,000 samples');
    should(actual).containEql('   50%  scan');
    should(actual).containEql('Hot functions — including callees');
    should(actual).containEql('   80%  walk');
    should(actual).containEql('Hot stacks');
    should(actual).containEql('Child processes  12 (24/min)');
    should(actual).containEql(
      'tmux capture-pane (3 synchronous) — p50 1.0 ms · p95 2.0 ms · max 3.0 ms · total 1.2 s · by turn watcher 8, live readout 2',
    );
    should(actual).containEql('  git status — p50');
    should(actual).containEql('Timers and background work — by total wall time');
    should(actual).containEql('tick — 120/min');
    should(actual).containEql('Routes — by total wall time');
    should(actual).containEql('GET /v1/sessions — 20/min');
    should(actual).containEql('· 3 errors · 0 KB');
    should(actual).containEql('· 4 KB');
    should(actual).containEql('File operations (the state-home port)  5,000 (166.7/s)');
    should(actual).containEql('readFile ~/.ferretry/state/index.json — p95 5.0 ms');
    should(actual).containEql('Workers — requests in flight');
    should(actual).containEql('scan-worker: mean 0.5 · max 2');
    should(actual).containEql('housekeeping: mean 0.2 · max 1');
    should(actual).containEql('6 jobs (12/min) · p50 5.0 ms');
    should(actual).containEql('3 files read · 2 requests · heap max 2.5 MB');
    should(actual).containEql('4/min  security find-generic-password · by fleet refresh 2 — p95 25 ms');
    should(actual).containEql('System calls (strace, 30 s)  3,000 (100/s)');
    should(actual).containEql('openat /etc/hosts');
    should(actual).containEql('programs started:');
    should(actual).containEql('4  git status');
    should(actual).containEql('What this report cannot see');
    should(actual).containEql('  - Syscalls are Linux only.');
  });

  it('should list a broken budget before one that held', () => {
    // Arrange
    const input = fullReport();

    // Act
    const actual = renderPerformanceReport(input);

    // Assert
    const over = actual.indexOf('OVER  stall: 400 ms (limit 200)');
    const ok = actual.indexOf('ok    idle cpu: 0.4 % (limit 1)');
    should(over).be.above(-1);
    should(ok).be.above(over);
  });

  it('should omit every optional section of a minimal report', () => {
    // Arrange
    const input = minimalReport();

    // Act
    const actual = renderPerformanceReport(input);

    // Assert
    for (const absent of [
      'Fleet:',
      'Budgets',
      'children',
      'Syscalls',
      'Hot functions',
      'Timers and background work',
      'Routes',
      'Workers',
      'System calls',
      'What this report cannot see',
    ])
      should(actual).not.containEql(absent);
    should(actual).containEql('CPU      0.5% of one core · user 5.0 ms · system 2.0 ms');
    should(actual).containEql('Child processes  0 (0/min)');
    should(actual).containEql('File operations (the state-home port)  0 (0/s)');
  });

  it('should show a trace without any programs started', () => {
    // Arrange
    const input: PerformanceReport = {
      ...minimalReport(),
      syscallTrace: { tool: 'fs_usage', seconds: 5, total: 0, perSecond: 0, top: [], executions: [] },
    };

    // Act
    const actual = renderPerformanceReport(input);

    // Assert
    should(actual).containEql('System calls (fs_usage, 5 s)  0 (0/s)');
    should(actual).not.containEql('programs started:');
  });

  it('should cut each table to its top rows', () => {
    // Arrange
    const input: PerformanceReport = {
      ...minimalReport(),
      activities: Array.from({ length: 20 }, (_, index) => ({
        name: `act${String(index)}`,
        count: 1,
        perMinute: 1,
        wall: wallStats(1),
      })),
      eventLoop: {
        ...minimalReport().eventLoop,
        stalls: Array.from({ length: 8 }, (_, index) => ({
          atOffsetMs: index,
          durationMs: 100,
          during: [`during${String(index)}`],
          stacks: [],
        })),
      },
    };

    // Act
    const actual = renderPerformanceReport(input);

    // Assert
    should(actual).containEql('act11 —');
    should(actual).not.containEql('act12 —');
    should(actual).containEql('during4');
    should(actual).not.containEql('during5');
  });

  it.each([
    [0.04, '0.0 ms'],
    [9.96, '10.0 ms'],
    [10, '10 ms'],
    [999.4, '999 ms'],
    [1_000, '1.0 s'],
    [12_345, '12.3 s'],
  ])('should format %d ms durations as %s', (input, expected) => {
    // Arrange
    const report = {
      ...minimalReport(),
      resources: { ...minimalReport().resources, cpu: { userMs: input, systemMs: 0, percentOfCore: 0 } },
    };

    // Act
    const actual = renderPerformanceReport(report);

    // Assert
    should(actual).containEql(`user ${expected}`);
  });

  it.each([
    [1_234_567, '1,234,567'],
    [3, '3'],
    [2.71, '2.7'],
  ])('should format the count %d as %s', (input, expected) => {
    // Arrange
    const report = { ...minimalReport(), childProcesses: { total: input, perMinute: 0, commands: [] } };

    // Act
    const actual = renderPerformanceReport(report);

    // Assert
    should(actual).containEql(`Child processes  ${expected} (0/min)`);
  });
});

describe('describeSessionWorkerPool', () => {
  it.each([
    [
      { enabled: false, max: 2, threads: 0, sessionsPerThread: [] },
      'off — every running session is observed on the main thread (sessionWorkers.enabled: false)',
    ],
    [
      { enabled: true, max: 2, threads: 0, sessionsPerThread: [] },
      'pool of 2 · no thread running (no session is running)',
    ],
    [{ enabled: true, max: 2, threads: 1, sessionsPerThread: [1] }, 'pool of 2 · 1 thread observing 1 session'],
    [{ enabled: true, max: 2, threads: 1, sessionsPerThread: [3] }, 'pool of 2 · 1 thread observing 3 sessions'],
    [{ enabled: true, max: 8, threads: 2, sessionsPerThread: [3, 2] }, 'pool of 8 · 2 threads observing 3, 2 sessions'],
  ])('should describe %j', (input, expected) => {
    // Act + Assert
    should(describeSessionWorkerPool(input)).equal(expected);
  });
});

describe('the session-worker pool in a report', () => {
  it('should show the pool when the report carries it, and nothing when it does not', () => {
    // Arrange
    const input: PerformanceReport = {
      ...minimalReport(),
      sessionWorkers: { enabled: true, max: 2, threads: 2, sessionsPerThread: [3, 2] },
    };

    // Act
    const withPool = renderPerformanceReport(input);
    const without = renderPerformanceReport(minimalReport());

    // Assert
    should(withPool).containEql('Session workers  pool of 2 · 2 threads observing 3, 2 sessions');
    should(without).not.containEql('Session workers');
  });
});
