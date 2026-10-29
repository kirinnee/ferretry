import { describe, it } from 'bun:test';
import { SessionAgendaModeSchema } from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  type SessionAgendaModeSubsystem,
  sessionAgendaModeRoutes,
} from '../../../../src/lib/runtime/mounts/session-agenda-mode.ts';
import { SessionAgendaModeError } from '../../../../src/lib/session/agenda-mode/service.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, human } from './support.ts';

class FakeAgendaMode implements SessionAgendaModeSubsystem {
  readonly calls: Array<readonly [string, boolean | 'get']> = [];

  constructor(private readonly refusal?: unknown) {}

  async get(sessionId: string) {
    this.calls.push([sessionId, 'get']);
    if (this.refusal !== undefined) throw this.refusal;
    return { enabled: false, restartRequired: false, note: 'Agenda mode is off.' };
  }

  async set(sessionId: string, enabled: boolean) {
    this.calls.push([sessionId, enabled]);
    if (this.refusal !== undefined) throw this.refusal;
    return { enabled, restartRequired: true, note: 'Agenda mode is on. Takes effect when the ferret restarts.' };
  }
}

const dispatcher = (subsystem: SessionAgendaModeSubsystem): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(sessionAgendaModeRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

const send = (method: 'GET' | 'PATCH', path: string, body?: string): Parameters<ApiDispatcher['dispatch']>[0] =>
  request({ method, path, headers: human, ...(body === undefined ? {} : { body }) });

describe('the session agenda-mode mount', () => {
  it('should mount both routes operator-only and uncached', () => {
    // Arrange + Act
    const routes = sessionAgendaModeRoutes(new FakeAgendaMode());

    // Assert
    should(routes.map(route => route.method)).deepEqual(['GET', 'PATCH']);
    should(routes.every(route => route.minimum === 'operator' && route.noStore === true)).be.true();
  });

  it('should read the switch', async () => {
    // Arrange
    const subsystem = new FakeAgendaMode();

    // Act
    const answer = await dispatcher(subsystem).dispatch(send('GET', '/v1/sessions/s1/agenda-mode'));

    // Assert
    should(answer.status).equal(200);
    should(SessionAgendaModeSchema.parse(JSON.parse(answer.body)).enabled).be.false();
  });

  it('should switch one ferret and say that it takes effect at its next launch', async () => {
    // Arrange
    const subsystem = new FakeAgendaMode();

    // Act
    const answer = await dispatcher(subsystem).dispatch(
      send('PATCH', '/v1/sessions/s1/agenda-mode', '{"enabled":true}'),
    );

    // Assert
    should(answer.status).equal(200);
    const result = SessionAgendaModeSchema.parse(JSON.parse(answer.body));
    should(result.enabled).be.true();
    should(result.restartRequired).be.true();
    should(subsystem.calls).deepEqual([['s1', true]]);
  });

  it('should refuse a body without the switch and a session that does not exist', async () => {
    // Arrange
    const valid = new FakeAgendaMode();
    const missing = new FakeAgendaMode(new SessionAgendaModeError('not-found', 'no session ghost'));

    // Act
    const bad = await dispatcher(valid).dispatch(send('PATCH', '/v1/sessions/s1/agenda-mode', '{"on":true}'));
    const gone = await dispatcher(missing).dispatch(send('GET', '/v1/sessions/ghost/agenda-mode'));
    const blank = await dispatcher(valid).dispatch(send('GET', '/v1/sessions/%E0%A4%A/agenda-mode'));

    // Assert
    should([bad.status, gone.status, blank.status]).deepEqual([400, 404, 400]);
    should(valid.calls).be.empty();
  });

  it('should pass on a fault it does not own', async () => {
    // Arrange
    const subsystem = new FakeAgendaMode(new Error('disk full'));

    // Act
    const answer = await dispatcher(subsystem).dispatch(
      send('PATCH', '/v1/sessions/s1/agenda-mode', '{"enabled":true}'),
    );

    // Assert
    should(answer.status).equal(500);
  });
});
