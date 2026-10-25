import type { HealthView } from '@ferretry/protocol';

/** A machine's health as `GET /v1/health` answers; `features` is left off to stand for a daemon from before the list. */
export const healthOf = (version: string, features?: string[]): HealthView => ({
  ok: true,
  bootstrapping: false,
  bootstrapState: 'complete',
  bootstrapDegraded: false,
  version,
  pid: 1,
  sessions: 0,
  running: 0,
  monitors: 0,
  unmonitoredRunning: 0,
  wardenLastSweepSeconds: null,
  wardenTimerArmed: false,
  eventLoopLagMs: 0,
  lastSelfCheckAt: null,
  wedgeCount: 0,
  scratchGcEnabled: false,
  scratchReclaimedSessions: 0,
  scratchReclaimedBytes: 0,
  bootstrapErrors: 0,
  time: '2026-10-25T00:00:00.000Z',
  ...(features === undefined ? {} : { features }),
});
