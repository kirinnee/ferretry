import { describe, it } from 'bun:test';
import should from 'should';
import {
  createMountedDispatcher,
  createMountedSocketDispatcher,
  mountedDaemonRoutes,
  mountedSocketRoutes,
  type MountedSubsystems,
} from '../../../../src/lib/runtime/index.ts';
import { fixedClock, request } from '../../api/support.ts';
import {
  analyticsSubsystem,
  attentionService,
  CREDENTIALS,
  emptyFeed,
  FakeSessionControl,
  FakeSessionResume,
  FakeTerminals,
  healthSubsystem,
  human,
  learningSubsystem,
  nameSubsystem,
  pinService,
  recommendSubsystem,
  sessionDirectory,
  sessionView,
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
  health: healthSubsystem(),
  attention: attentionService(),
  pins: pinService([]),
  sessions: sessionDirectory([sessionView('s1')]),
  sessionControl: new FakeSessionControl(),
  sessionResume: new FakeSessionResume(),
  tasks: taskSubsystem(),
  analytics: analyticsSubsystem(),
  terminals: new FakeTerminals(),
  names: nameSubsystem(),
  learning: learningSubsystem(),
  recommend: recommendSubsystem(),
});

describe('the mounted daemon surface', () => {
  it('should serve the base feeds and every mounted subsystem from one table', () => {
    // Arrange / Act
    const routes = mountedDaemonRoutes(base, subsystems()).map(route => `${route.method} ${route.path}`);

    // Assert
    should(routes).deepEqual([
      'GET /healthz',
      'GET /usage',
      'GET /v1/usage',
      'GET /metrics',
      'GET /v1/health',
      'GET /v1/sessions',
      'GET /v1/sessions/:sessionId',
      'POST /v1/sessions',
      'POST /v1/sessions/:sessionId/stop',
      'POST /v1/sessions/:sessionId/resume',
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
      'GET /v1/names',
      'GET /v1/learning/status',
      'GET /v1/learning/config',
      'GET /v1/learning/proposals',
      'POST /v1/learning/proposals/:id',
      'GET /v1/learning/proposals/:id/patch',
      'POST /v1/learning/run',
      'POST /v1/recommend',
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
    const report = await dispatcher.dispatch(request({ path: '/v1/health', headers: human }));
    const sessions = await dispatcher.dispatch(request({ path: '/v1/sessions', headers: human }));
    const session = await dispatcher.dispatch(request({ path: '/v1/sessions/s1', headers: human }));
    const pins = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/pins', headers: human }));
    const attention = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/attention', headers: human }));
    const tasks = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/tasks', headers: human }));
    const fleet = await dispatcher.dispatch(request({ path: '/v1/tasks', headers: human }));
    const analytics = await dispatcher.dispatch(request({ path: '/v1/analytics', headers: human }));
    const terminals = await dispatcher.dispatch(request({ path: '/v1/sessions/s1/terminals', headers: human }));
    const learning = await dispatcher.dispatch(request({ path: '/v1/learning/status', headers: human }));
    // The write half of the session surface, over the same dispatcher: a stop of a session the
    // fixture holds, which an unmounted route would answer as `unknown_route`.
    const stopped = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/sessions/s1/stop', headers: human, body: '{}' }),
    );
    // The revive, over the same dispatcher: the route the protocol client's `resume` speaks, which
    // answered `unknown_route` until the resume service was mounted behind it.
    const revived = await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/sessions/s1/resume', headers: human, body: '{}' }),
    );

    // Assert
    should(health.status).equal(200);
    // The liveness probe and the scoped report are two different answers under one subject, and both
    // are reached: the daemon's own health is a mounted subsystem now, not a hardcoded literal.
    should(report.status).equal(200);
    should(sessions.status).equal(200);
    // The id pattern is reached rather than shadowed by the deeper per-session routes below it.
    should(session.status).equal(200);
    // The session is unknown to this fixture, which still proves the route is mounted and reached.
    should(pins.status).equal(404);
    should(attention.status).equal(200);
    should(tasks.status).equal(200);
    should(fleet.status).equal(200);
    should(analytics.status).equal(200);
    should(terminals.status).equal(200);
    should(learning.status).equal(200);
    should(stopped.status).equal(200);
    should(revived.status).equal(200);
  });

  it('should serve every protocol-switching route from one table too', () => {
    // The same "is it mounted" assertion as above, for the surface that answers with a socket rather
    // than a body. A stream missing from here is a capability the product does not have, however
    // completely `TerminalStreamBridge` is built and tested.
    // Arrange / Act
    const routes = mountedSocketRoutes(subsystems()).map(route => `${route.method} ${route.path}`);

    // Assert
    should(routes).deepEqual(['GET /v1/sessions/:sessionId/terminals/:terminalId/stream']);
  });

  it('should authorize a protocol switch over the same credentials as the HTTP surface', async () => {
    // Two dispatchers, one credential set. A socket dispatcher built from different credentials would
    // be a second, quieter authorization boundary, and the two would drift.
    // Arrange
    const dispatcher = createMountedSocketDispatcher(base, subsystems());
    const path = '/v1/sessions/s1/terminals/0123456789ab/stream';

    // Act
    const anonymous = await dispatcher.upgrade(request({ path }));
    const authorized = await dispatcher.upgrade(request({ path, headers: human }));

    // Assert
    should(anonymous.outcome === 'refused' ? anonymous.response.status : 0).equal(401);
    // The terminal does not exist in this fixture, which still proves the route is mounted, reached,
    // and that existence is decided BEFORE any protocol switch.
    should(authorized.outcome === 'refused' ? authorized.response.status : 0).equal(404);
  });
});
