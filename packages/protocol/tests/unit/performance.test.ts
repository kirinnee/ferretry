import { describe, it } from 'bun:test';
import should from 'should';
import {
  PERFORMANCE_PROFILE_MAX_SECONDS,
  PERFORMANCE_PROFILE_MIN_SECONDS,
  PERFORMANCE_REPORT_VERSION,
  PerformanceProfileRequestSchema,
  PerformanceProfileViewSchema,
  PerformanceReportSchema,
} from '../../src/lib/performance.ts';

const wall = { totalMs: 12, p50Ms: 1, p95Ms: 3, maxMs: 4 };
const gauge = { min: 1, mean: 2, max: 3 };

const fullReport = () => ({
  version: PERFORMANCE_REPORT_VERSION,
  startedAt: '2026-10-21T08:00:00.000Z',
  endedAt: '2026-10-21T08:00:30.000Z',
  windowMs: 30_000,
  daemon: { version: '1.2.3', platform: 'linux', arch: 'x64', runtime: 'bun 1.3', uptimeSeconds: 3600 },
  fleet: { sessions: 36, running: 4 },
  resources: {
    cpu: { userMs: 100, systemMs: 50, percentOfCore: 0.5, childrenMs: 20 },
    memory: { rssMb: gauge, heapUsedMb: gauge, externalMb: gauge },
    syscalls: { reads: 10, writes: 5, perSecond: 0.5 },
    contextSwitches: { voluntary: 7, involuntary: 1 },
  },
  eventLoop: {
    ticks: 300,
    lag: { p50Ms: 1, p95Ms: 2, maxMs: 120 },
    blocksOver100Ms: 1,
    blocksOver250Ms: 0,
    blockedMs: 120,
    stalls: [{ atOffsetMs: 500, durationMs: 120, during: ['index refresh'], stacks: [{ stack: 'a < b', share: 0.5 }] }],
  },
  cpuProfile: {
    samples: 10,
    self: [{ frame: 'readdir', samples: 5, share: 0.5 }],
    inclusive: [{ frame: 'scan', samples: 8, share: 0.8 }],
    stacks: [{ stack: 'readdir < scan', samples: 5, share: 0.5 }],
  },
  activities: [{ name: 'index', count: 3, perMinute: 6, wall }],
  routes: [{ route: 'GET /v1/sessions/:id', count: 2, perMinute: 4, errors: 1, wall, bytes: { total: 100, max: 60 } }],
  childProcesses: {
    total: 4,
    perMinute: 8,
    commands: [{ command: 'tmux capture-pane', count: 4, perMinute: 8, synchronous: 1, wall }],
  },
  fileOperations: {
    total: 9,
    perSecond: 0.3,
    top: [
      {
        operation: 'readFile',
        path: '~/.ferretry/state/sessions/<session>/state.json',
        count: 9,
        perSecond: 0.3,
        wall,
      },
    ],
  },
  workers: [{ name: 'transcript', inFlight: gauge }],
  budgets: [{ name: 'idle cpu', unit: '%', limit: 1, actual: 0.5, ok: true }],
  syscallTrace: {
    tool: 'strace',
    seconds: 30,
    total: 90,
    perSecond: 3,
    top: [{ call: 'read', path: '<fd>', count: 90, perSecond: 3 }],
    executions: [{ command: 'tmux capture-pane', count: 4 }],
  },
  limitations: ['no syscalls on macOS'],
});

describe('PerformanceReportSchema', () => {
  it('should accept a full valid report', () => {
    // Arrange
    const input = fullReport();

    // Act
    const actual = PerformanceReportSchema.safeParse(input);

    // Assert
    should(actual.success).be.true();
  });

  it('should accept a report without its optional sections', () => {
    // Arrange
    const { fleet, syscallTrace, ...rest } = fullReport();
    const { syscalls, ...process } = rest.resources;
    const input = { ...rest, resources: { ...process, cpu: { userMs: 1, systemMs: 1, percentOfCore: 0 } } };

    // Act
    const actual = PerformanceReportSchema.safeParse(input);

    // Assert
    should(actual.success).be.true();
  });

  it('should refuse a version it does not know', () => {
    // Arrange
    const input = { ...fullReport(), version: 2 };

    // Act
    const actual = PerformanceReportSchema.safeParse(input);

    // Assert
    should(actual.success).be.false();
  });
});

describe('PerformanceProfileRequestSchema', () => {
  it.each([
    [PERFORMANCE_PROFILE_MIN_SECONDS - 1, false],
    [PERFORMANCE_PROFILE_MIN_SECONDS, true],
    [PERFORMANCE_PROFILE_MAX_SECONDS, true],
    [PERFORMANCE_PROFILE_MAX_SECONDS + 1, false],
    [30.5, false],
  ])('should bound the window (%d seconds -> accepted: %s)', (seconds, expected) => {
    // Arrange
    const input = { seconds };

    // Act
    const actual = PerformanceProfileRequestSchema.safeParse(input).success;

    // Assert
    should(actual).equal(expected);
  });
});

describe('PerformanceProfileViewSchema', () => {
  it('should accept a running profile and a finished one', () => {
    // Arrange
    const running = { state: 'running', id: 'p1', startedAt: 'a', endsAt: 'b' };
    const finished = { state: 'finished', id: 'p1', report: fullReport() };

    // Act
    const actual = [running, finished].map(input => PerformanceProfileViewSchema.safeParse(input).success);

    // Assert
    should(actual).deepEqual([true, true]);
  });

  it('should refuse an unknown state', () => {
    // Arrange
    const input = { state: 'paused', id: 'p1' };

    // Act
    const actual = PerformanceProfileViewSchema.safeParse(input);

    // Assert
    should(actual.success).be.false();
  });
});
