import { type HealthView, HealthViewSchema } from '@ferretry/protocol';

/**
 * A complete health report, as one of these daemons publishes it.
 *
 * PARSED THROUGH THE REAL SCHEMA on the way out, so the fixture cannot drift from what identification
 * will actually accept. A hand-written object that quietly stopped satisfying the schema would make
 * every "this responder is one of ours" test pass for the wrong reason — the identification would be
 * refusing the fixture, and refusing is also what the tests around it expect of a stranger.
 */
export function healthViewFixture(overrides: Partial<HealthView> = {}): HealthView {
  return HealthViewSchema.parse({
    ok: true,
    bootstrapping: false,
    bootstrapState: 'complete',
    bootstrapDegraded: false,
    version: '1.2.3',
    pid: 4_321,
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
    time: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}
