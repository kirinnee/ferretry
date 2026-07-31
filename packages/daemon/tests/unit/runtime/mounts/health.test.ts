import { describe, it } from 'bun:test';
import { HealthViewSchema } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { daemonHealthRoutes, type DaemonHealthSubsystem } from '../../../../src/lib/runtime/mounts/health.ts';
import { request } from '../../api/support.ts';
import { AT, CREDENTIALS, HEALTH_VERSION, healthObservation, healthSubsystem, human } from './support.ts';

/**
 * The daemon's own health route, driven through the real router over the real self-check.
 *
 * The response is PARSED against the protocol's own `HealthViewSchema` rather than checked field by
 * field, because parsing is the whole point of this mount: the route it replaced answered with a
 * three-field liveness body that this schema refuses, so the CLI — which probes through the schema
 * and treats a failure as "did not answer" — reported a serving daemon as unreachable.
 */

function dispatcher(subsystem: DaemonHealthSubsystem): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(daemonHealthRoutes(subsystem)), CREDENTIALS);
}

async function ask(subsystem: DaemonHealthSubsystem, headers: Record<string, string> = { ...human }) {
  return await dispatcher(subsystem).dispatch(request({ path: '/v1/health', headers }));
}

describe('the daemon health mount', () => {
  it('should answer in the wire shape the CLI parses', async () => {
    // Arrange
    const subsystem = healthSubsystem({
      sessions: [healthObservation('s1'), healthObservation('s2', { terminal: true })],
      pid: 4242,
    });

    // Act
    const response = await ask(subsystem);

    // Assert
    should(response.status).equal(200);
    const view = HealthViewSchema.parse(JSON.parse(response.body));
    should(view.version).equal(HEALTH_VERSION);
    should(view.pid).equal(4242);
    // Counted by the real report builder from the real inventory: two known, one still able to run.
    should([view.sessions, view.running]).deepEqual([2, 1]);
    should(view.time).equal(AT);
  });

  it('should report a fresh daemon as healthy and not yet self-checked', async () => {
    // A daemon that has bound its port but not ticked has an empty ledger, and an empty ledger is
    // boot rather than a fault — reporting `ok: false` would make every boot look like an outage.
    // Arrange / Act
    const view = HealthViewSchema.parse(JSON.parse((await ask(healthSubsystem())).body));

    // Assert
    should(view.ok).be.true();
    should(view.bootstrapping).be.false();
    should(view.bootstrapState).equal('complete');
    should(view.bootstrapDegraded).be.false();
    should(view.lastSelfCheckAt).be.null();
    should([view.wedgeCount, view.eventLoopLagMs]).deepEqual([0, 0]);
  });

  it('should report the instant of the self-check that actually ran', async () => {
    // Arrange — two on-time ticks through the real ledger
    const subsystem = healthSubsystem({ ticks: 2 });

    // Act
    const view = HealthViewSchema.parse(JSON.parse((await ask(subsystem)).body));

    // Assert
    should(view.lastSelfCheckAt).equal(AT);
    // Two ticks one interval apart is exactly on time, so the daemon is neither wedged nor lagging.
    should([view.wedgeCount, view.eventLoopLagMs]).deepEqual([0, 0]);
  });

  it('should never claim a warden timer this daemon does not arm', async () => {
    // Reporting an armed timer would make a permanently absent sweep read as a broken one, and the
    // age of a sweep that never happened is unknown rather than zero.
    // Arrange / Act
    const view = HealthViewSchema.parse(JSON.parse((await ask(healthSubsystem())).body));

    // Assert
    should(view.wardenTimerArmed).be.false();
    should(view.wardenLastSweepSeconds).be.null();
  });

  it('should age a sweep in whole seconds once a warden has swept', async () => {
    // Arrange — a sweep 90 seconds before the fixture's wall instant
    const sweptAt = new Date(Date.parse(AT) - 90_000).toISOString();
    const subsystem = healthSubsystem({ supervisesWarden: true, lastSweepAt: sweptAt });

    // Act
    const view = HealthViewSchema.parse(JSON.parse((await ask(subsystem)).body));

    // Assert
    should(view.wardenTimerArmed).be.true();
    should(view.wardenLastSweepSeconds).equal(90);
  });

  it('should count running sessions no monitor is watching, without calling that a fault', async () => {
    // This daemon mounts no monitor subsystem, so every running session is unmonitored. That is a
    // capability it does not have, not a fleet-wide outage — `ok` must survive it.
    // Arrange
    const subsystem = healthSubsystem({ sessions: [healthObservation('s1'), healthObservation('s2')] });

    // Act
    const view = HealthViewSchema.parse(JSON.parse((await ask(subsystem)).body));

    // Assert
    should([view.monitors, view.unmonitoredRunning]).deepEqual([0, 2]);
    should(view.ok).be.true();
  });

  it('should condemn a daemon whose monitors it does supervise and cannot account for', async () => {
    // Arrange — a daemon that DOES run monitors, with a running session none is watching
    const subsystem = healthSubsystem({
      supervisesMonitors: true,
      sessions: [healthObservation('s1'), healthObservation('s2', { monitored: true })],
    });

    // Act
    const view = HealthViewSchema.parse(JSON.parse((await ask(subsystem)).body));

    // Assert
    should([view.monitors, view.unmonitoredRunning]).deepEqual([1, 1]);
    should(view.ok).be.false();
  });

  it('should show the bootstrap errors an operator has to act on', async () => {
    // Arrange
    const subsystem = healthSubsystem({ bootstrapErrors: ['index rebuild failed', 'journal unreadable'] });

    // Act
    const view = HealthViewSchema.parse(JSON.parse((await ask(subsystem)).body));

    // Assert
    should(view.bootstrapState).equal('degraded');
    // The boolean and the enum are derived from one another, so they cannot disagree on the wire.
    should(view.bootstrapDegraded).be.true();
    should(view.bootstrapErrors).equal(2);
    should(view.bootstrapErrorMessages).deepEqual(['index rebuild failed', 'journal unreadable']);
  });

  it('should omit the error list entirely when there were none', async () => {
    // An empty list reads as "the messages were withheld"; the count already says there were none.
    // Arrange / Act
    const body = JSON.parse((await ask(healthSubsystem())).body) as Record<string, unknown>;

    // Assert
    should(body).not.have.property('bootstrapErrorMessages');
    should(body).have.property('bootstrapErrors', 0);
  });

  it('should report a daemon still bootstrapping as such', async () => {
    // Arrange / Act
    const view = HealthViewSchema.parse(JSON.parse((await ask(healthSubsystem({ bootstrapFinished: false }))).body));

    // Assert
    should(view.bootstrapping).be.true();
    should(view.bootstrapState).equal('running');
    should(view.ok).be.false();
  });

  it('should state that nothing reclaims scratch space, rather than that nothing was reclaimed', async () => {
    // Arrange / Act
    const view = HealthViewSchema.parse(JSON.parse((await ask(healthSubsystem())).body));

    // Assert
    should(view.scratchGcEnabled).be.false();
    should([view.scratchReclaimedSessions, view.scratchReclaimedBytes]).deepEqual([0, 0]);
  });

  it('should report the collector totals once a reclaimer is mounted', async () => {
    // The mount states no policy of its own: whatever the composition root says was reclaimed is
    // what the wire carries, so landing a collector needs no change here.
    // Arrange
    const subsystem = healthSubsystem({ scratch: { enabled: true, reclaimedSessions: 3, reclaimedBytes: 4_096 } });

    // Act
    const view = HealthViewSchema.parse(JSON.parse((await ask(subsystem)).body));

    // Assert
    should([view.scratchGcEnabled, view.scratchReclaimedSessions, view.scratchReclaimedBytes]).deepEqual([
      true,
      3,
      4_096,
    ]);
  });

  it('should answer a caller holding no token at all', async () => {
    // Not an oversight: `fy daemon status` has to report whether the daemon is up BEFORE a token
    // exists, which is exactly the state a fresh `fy daemon install` leaves a host in. The CLI's
    // health client sends a placeholder token for that case and relies on this route ignoring it.
    // Arrange / Act
    const response = await dispatcher(healthSubsystem()).dispatch(request({ path: '/v1/health' }));

    // Assert
    should(response.status).equal(200);
    should(HealthViewSchema.parse(JSON.parse(response.body)).version).equal(HEALTH_VERSION);
  });

  it('should answer a warden, who supervises the fleet this describes', async () => {
    // Arrange / Act
    const response = await ask(healthSubsystem(), { authorization: `Bearer ${CREDENTIALS.warden}` });

    // Assert
    should(response.status).equal(200);
  });

  it('should never let a cached answer stand in for a live measurement', async () => {
    // A stale health response is the exact failure this subsystem exists to catch: a starved daemon
    // reporting all-clear.
    // Arrange / Act
    const response = await ask(healthSubsystem());

    // Assert
    should(response.headers.get('cache-control')).match(/no-store/u);
  });
});
