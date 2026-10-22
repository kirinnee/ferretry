/**
 * The Performance panel's in-memory machine for the harness: a profile that starts at once, closes after
 * a second and a half, and reads back a report shaped like a real idle machine's — 36 sessions, one
 * budget over (child processes), the tmux reads the turn watcher started, and the limitations the
 * daemon states. Beside it, this browser's recorder already holds a minute of ordinary idle reads, so
 * both halves of the report have something true-looking on them.
 */

import type { PerformanceProfileView, PerformanceReport } from '@ferretry/protocol';
import type { PerformanceClient } from '../src/features/settings/performance-api.ts';
import { PerformanceRecorder } from '../src/lib/performance/recorder.ts';

const wall = (totalMs: number, p50Ms: number, p95Ms: number, maxMs: number) => ({ totalMs, p50Ms, p95Ms, maxMs });

const HARNESS_PERFORMANCE_REPORT: PerformanceReport = {
  version: 1,
  startedAt: '2026-10-22T09:00:00.000Z',
  endedAt: '2026-10-22T09:00:30.000Z',
  windowMs: 30_000,
  daemon: { version: '4.67.0', platform: 'darwin', arch: 'arm64', runtime: 'bun 1.3.13', uptimeSeconds: 52_200 },
  fleet: { sessions: 36, running: 5 },
  resources: {
    cpu: { userMs: 1_140, systemMs: 380, percentOfCore: 5.1 },
    memory: {
      rssMb: { min: 212, mean: 218.4, max: 226 },
      heapUsedMb: { min: 88, mean: 94.2, max: 101 },
      externalMb: { min: 12, mean: 12.5, max: 13 },
    },
    contextSwitches: { voluntary: 4_210, involuntary: 96 },
  },
  eventLoop: {
    ticks: 30_000,
    lag: { p50Ms: 0.6, p95Ms: 4.2, maxMs: 131 },
    blocksOver100Ms: 1,
    blocksOver250Ms: 0,
    blockedMs: 131,
    stalls: [
      {
        atOffsetMs: 12_400,
        durationMs: 131,
        during: ['fleet refresh'],
        stacks: [{ stack: 'parseSessionState < readDocument < refreshFleet', share: 0.62 }],
      },
    ],
  },
  cpuProfile: {
    samples: 3_000,
    self: [
      { frame: 'JSON.parse', samples: 210, share: 0.07 },
      { frame: 'parseSessionState (session/state.ts)', samples: 150, share: 0.05 },
    ],
    inclusive: [
      { frame: 'refreshFleet (runtime/fleet.ts)', samples: 540, share: 0.18 },
      { frame: 'TurnWatcher.tick (session/turns.ts)', samples: 330, share: 0.11 },
    ],
    stacks: [{ stack: 'JSON.parse < readDocument < refreshFleet', samples: 120, share: 0.04 }],
  },
  activities: [
    { name: 'turn watcher', count: 15, perMinute: 30, wall: wall(410, 22, 48, 61) },
    { name: 'fleet refresh', count: 6, perMinute: 12, wall: wall(380, 51, 131, 131) },
  ],
  routes: [
    {
      route: 'GET /v1/sessions',
      count: 2,
      perMinute: 4,
      errors: 0,
      wall: wall(24, 11, 13, 13),
      bytes: { total: 51_200, max: 25_600 },
    },
    {
      route: 'GET /v1/warden/status',
      count: 1,
      perMinute: 2,
      errors: 0,
      wall: wall(3, 3, 3, 3),
      bytes: { total: 2_048, max: 2_048 },
    },
  ],
  childProcesses: {
    total: 24,
    perMinute: 48,
    commands: [
      {
        command: 'tmux capture-pane',
        count: 20,
        perMinute: 40,
        synchronous: 0,
        wall: wall(260, 12, 21, 30),
        by: [
          { activity: 'turn watcher', count: 15 },
          { activity: 'live readout', count: 5 },
        ],
      },
      {
        command: 'git status',
        count: 4,
        perMinute: 8,
        synchronous: 0,
        wall: wall(220, 51, 70, 74),
        by: [{ activity: 'fleet refresh', count: 4 }],
      },
    ],
  },
  fileOperations: {
    total: 1_260,
    perSecond: 42,
    top: [
      {
        operation: 'readFile',
        path: '~/.ferretry/state/sessions/<session>/state.json',
        count: 720,
        perSecond: 24,
        wall: wall(180, 0.2, 0.6, 3),
      },
    ],
  },
  workers: [{ name: 'analytics', inFlight: { min: 0, mean: 0.1, max: 1 } }],
  budgets: [
    { name: 'child processes', unit: '/min', limit: 30, actual: 48, ok: false },
    { name: 'CPU', unit: '% of a core', limit: 10, actual: 5.1, ok: true },
    { name: 'event-loop stall', unit: 'ms', limit: 250, actual: 131, ok: true },
  ],
  limitations: [
    'Stacks are sampled every 10 ms, so a share is an estimate.',
    'File operations count the state-home port only, not files a child process opens.',
  ],
};

/** A profile that runs for `windowMs` of real time, then reads back the fixture report. */
export const harnessPerformanceClient =
  (windowMs = 1_500) =>
  async (): Promise<PerformanceClient> => {
    let startedAt = 0;
    return {
      request: (async (_path: string, _schema: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') {
          startedAt = Date.now();
          const view: PerformanceProfileView = {
            state: 'running',
            id: 'harness-profile',
            startedAt: new Date(startedAt).toISOString(),
            endsAt: new Date(startedAt + windowMs).toISOString(),
          };
          return view;
        }
        const view: PerformanceProfileView =
          Date.now() - startedAt < windowMs
            ? {
                state: 'running',
                id: 'harness-profile',
                startedAt: new Date(startedAt).toISOString(),
                endsAt: new Date(startedAt + windowMs).toISOString(),
              }
            : { state: 'finished', id: 'harness-profile', report: HARNESS_PERFORMANCE_REPORT };
        return view;
      }) as PerformanceClient['request'],
    };
  };

/** This browser's recorder, with a minute of an idle fleet page's reads already on it. */
export const harnessRecorder = (): PerformanceRecorder => {
  const recorder = new PerformanceRecorder({ now: () => performance.now() });
  const at = performance.now();
  const reads: readonly (readonly [string, number, number])[] = [
    ['GET /v1/sessions', 116, 25_600],
    ['GET /v1/sessions', 98, 25_600],
    ['GET /v1/warden/status', 41, 2_048],
    ['GET /v1/usage', 37, 300],
    ['GET /v1/diagnostics/profile/:id', 52, 9_000],
  ];
  for (const [route, durationMs, bytesIn] of reads)
    recorder.recordRequest({ route, at, durationMs, outcome: 200, bytesIn, bytesOut: 0 });
  recorder.recordRender('fleet', 4);
  recorder.recordRender('fleet', 9);
  return recorder;
};
