import { describe, it } from 'bun:test';
import should from 'should';
import {
  createMountedDispatcher,
  mountedDaemonRoutes,
  type MountedSubsystems,
} from '../../../../src/lib/runtime/index.ts';
import { fixedClock, request } from '../../api/support.ts';
import {
  analyticsSubsystem,
  attentionService,
  CREDENTIALS,
  emptyFeed,
  FakeTerminals,
  human,
  pinService,
  taskSubsystem,
} from './support.ts';

/**
 * The complete surface the daemon process serves.
 *
 * This is the test that catches the migration's recurring defect: a subsystem built, tested and
 * never mounted. A route missing from this table is a capability the product does not have.
 */

const base = { credentials: CREDENTIALS, usage: emptyFeed, clock: fixedClock(1_700_000_000_000), startedAtMs: 0 };

const subsystems = (): MountedSubsystems => ({
  attention: attentionService(),
  pins: pinService([]),
  tasks: taskSubsystem(),
  analytics: analyticsSubsystem(),
  terminals: new FakeTerminals(),
});

describe('the mounted daemon surface', () => {
  it('should serve the base feeds and every mounted subsystem from one table', () => {
    // Arrange / Act
    const routes = mountedDaemonRoutes(base, subsystems()).map(route => `${route.method} ${route.path}`);

    // Assert
    should(routes).deepEqual([
      'GET /healthz',
      'GET /v1/health',
      'GET /usage',
      'GET /v1/usage',
      'GET /metrics',
      'GET /v1/sessions/:sessionId/attention',
      'POST /v1/sessions/:sessionId/attention',
      'GET /v1/sessions/:sessionId/pins',
      'POST /v1/sessions/:sessionId/pins',
      'GET /v1/tasks',
      'GET /v1/sessions/:sessionId/tasks',
      'POST /v1/sessions/:sessionId/tasks',
      'GET /v1/sessions/:sessionId/tasks/:taskId',
      'POST /v1/sessions/:sessionId/tasks/:taskId',
      'GET /v1/analytics',
      'GET /v1/sessions/:sessionId/terminals',
      'POST /v1/sessions/:sessionId/terminals',
      'GET /v1/sessions/:sessionId/terminals/:terminalId',
      'POST /v1/sessions/:sessionId/terminals/:terminalId',
      'DELETE /v1/sessions/:sessionId/terminals/:terminalId',
    ]);
  });

  it('should never let a subsystem pattern shadow a base feed', () => {
    // The base feeds are fixed literal paths, so registration order cannot hide one behind a
    // parameterised subsystem route. Asserting it here means a future mount cannot break liveness.
    // Arrange
    const routes = mountedDaemonRoutes(base, subsystems());

    // Act
    const firstLiteral = routes.findIndex(route => route.path === '/healthz');
    const firstPattern = routes.findIndex(route => route.path.includes(':'));

    // Assert
    should(firstLiteral).be.below(firstPattern);
  });

  it('should dispatch a base feed and a subsystem route through the same dispatcher', async () => {
    // Arrange
    const dispatcher = createMountedDispatcher(base, subsystems());

    // Act
    const health = await dispatcher.dispatch(request({ path: '/healthz' }));
    const pins = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/pins', headers: human }));
    const attention = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/attention', headers: human }));
    const tasks = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/tasks', headers: human }));
    const fleet = await dispatcher.dispatch(request({ path: '/v1/tasks', headers: human }));
    const analytics = await dispatcher.dispatch(request({ path: '/v1/analytics', headers: human }));
    const terminals = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/terminals', headers: human }));

    // Assert
    should(health.status).equal(200);
    // The session is unknown to this fixture, which still proves the route is mounted and reached.
    should(pins.status).equal(404);
    should(attention.status).equal(200);
    should(tasks.status).equal(200);
    should(fleet.status).equal(200);
    should(analytics.status).equal(200);
    should(terminals.status).equal(200);
  });
});
