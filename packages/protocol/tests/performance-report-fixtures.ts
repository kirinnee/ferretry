import type { DurationStats, PerformanceReport } from '../src/lib/performance.ts';

export const wallStats = (totalMs: number, p50Ms = 1, p95Ms = 2, maxMs = 3): DurationStats => ({
  totalMs,
  p50Ms,
  p95Ms,
  maxMs,
});

const gauge = { min: 1, mean: 2, max: 3 };

/** The smallest valid report: every optional section absent and every table empty. */
export function minimalReport(): PerformanceReport {
  return {
    version: 1,
    startedAt: '2026-10-21T10:00:00.000Z',
    endedAt: '2026-10-21T10:00:30.000Z',
    windowMs: 30_000,
    daemon: { version: '1.2.3', platform: 'linux', arch: 'x64', runtime: 'bun 1.3', uptimeSeconds: 90 },
    resources: {
      cpu: { userMs: 5, systemMs: 2, percentOfCore: 0.5 },
      memory: { rssMb: gauge, heapUsedMb: gauge, externalMb: gauge },
      contextSwitches: { voluntary: 10, involuntary: 2 },
    },
    eventLoop: {
      ticks: 30,
      lag: { p50Ms: 1, p95Ms: 2, maxMs: 3 },
      blocksOver100Ms: 0,
      blocksOver250Ms: 0,
      blockedMs: 0,
      stalls: [],
    },
    cpuProfile: { samples: 0, self: [], inclusive: [], stacks: [] },
    activities: [],
    routes: [],
    childProcesses: { total: 0, perMinute: 0, commands: [] },
    fileOperations: { total: 0, perSecond: 0, top: [] },
    workers: [],
    budgets: [],
    limitations: [],
  };
}

/** A report with every optional section present. */
export function fullReport(): PerformanceReport {
  return {
    ...minimalReport(),
    fleet: { sessions: 36, running: 4 },
    resources: {
      cpu: { userMs: 1_500, systemMs: 250.5, percentOfCore: 12.34, childrenMs: 800 },
      memory: {
        rssMb: { min: 100, mean: 120.25, max: 140 },
        heapUsedMb: { min: 50, mean: 60, max: 70 },
        externalMb: { min: 5, mean: 6, max: 7 },
      },
      syscalls: { reads: 1_200, writes: 300, perSecond: 50 },
      contextSwitches: { voluntary: 1_000, involuntary: 20 },
    },
    eventLoop: {
      ticks: 300,
      lag: { p50Ms: 1.5, p95Ms: 20, maxMs: 1_500 },
      blocksOver100Ms: 2,
      blocksOver250Ms: 1,
      blockedMs: 900,
      stalls: [
        {
          atOffsetMs: 2_000,
          durationMs: 400,
          during: ['sessions.scan', 'index.rebuild'],
          stacks: [{ stack: 'scan < walk', share: 0.75 }],
        },
        { atOffsetMs: 5_000, durationMs: 120, during: [], stacks: [] },
      ],
    },
    cpuProfile: {
      samples: 1_000,
      self: [{ frame: 'scan', samples: 500, share: 0.5 }],
      inclusive: [{ frame: 'walk', samples: 800, share: 0.8 }],
      stacks: [{ stack: 'scan < walk', samples: 400, share: 0.4 }],
    },
    activities: [{ name: 'tick', count: 60, perMinute: 120, wall: wallStats(600) }],
    routes: [
      {
        route: 'GET /v1/sessions',
        count: 10,
        perMinute: 20,
        errors: 0,
        wall: wallStats(50),
        bytes: { total: 4_096, max: 2_048 },
      },
      { route: 'POST /v1/x', count: 4, perMinute: 8, errors: 3, wall: wallStats(20), bytes: { total: 100, max: 50 } },
    ],
    childProcesses: {
      total: 12,
      perMinute: 24,
      commands: [
        {
          command: 'tmux capture-pane',
          count: 10,
          perMinute: 20,
          synchronous: 3,
          wall: wallStats(1_200),
          by: [
            { activity: 'turn watcher', count: 8 },
            { activity: 'live readout', count: 2 },
          ],
        },
        { command: 'git status', count: 2, perMinute: 4, synchronous: 0, wall: wallStats(2_400), by: [] },
      ],
    },
    fileOperations: {
      total: 5_000,
      perSecond: 166.67,
      top: [
        {
          operation: 'readFile',
          path: '~/.ferretry/state/index.json',
          count: 900,
          perSecond: 30,
          wall: wallStats(90, 1, 5, 9),
        },
      ],
    },
    workers: [
      { name: 'scan-worker', inFlight: { min: 0, mean: 0.5, max: 2 } },
      {
        name: 'housekeeping',
        inFlight: { min: 0, mean: 0.2, max: 1 },
        work: {
          jobs: 6,
          perMinute: 12,
          wall: wallStats(60, 5, 20, 30),
          childProcesses: [
            {
              command: 'security find-generic-password',
              count: 2,
              perMinute: 4,
              synchronous: 0,
              wall: wallStats(40, 15, 25, 25),
              by: [{ activity: 'fleet refresh', count: 2 }],
            },
          ],
          fileReads: 3,
          fetches: 2,
          heapMb: { min: 1.5, mean: 2, max: 2.5 },
        },
      },
    ],
    budgets: [
      { name: 'idle cpu', unit: '%', limit: 1, actual: 0.4, ok: true },
      { name: 'stall', unit: 'ms', limit: 200, actual: 400, ok: false },
    ],
    syscallTrace: {
      tool: 'strace',
      seconds: 30,
      total: 3_000,
      perSecond: 100,
      top: [{ call: 'openat', path: '/etc/hosts', count: 600, perSecond: 20 }],
      executions: [{ command: 'git status', count: 4 }],
    },
    limitations: ['Syscalls are Linux only.'],
  };
}
