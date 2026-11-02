import { describe, it } from 'bun:test';
import { type SessionView, SessionViewSchema } from '@ferretry/protocol';
import should from 'should';
import { AgentPinError } from '../../../../src/lib/agent-pins/index.ts';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { type SessionPinSubsystem, sessionPinRoutes } from '../../../../src/lib/runtime/mounts/session-pin.ts';
import { request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, human, sessionView } from './support.ts';

class FakePins implements SessionPinSubsystem {
  readonly calls: string[] = [];
  async pin(reference: string): Promise<SessionView> {
    this.calls.push(`pin ${reference}`);
    if (reference === 'ghost') throw new AgentPinError('not-found', 'no session ghost');
    if (reference === 'crowded') throw new AgentPinError('full', 'too many');
    return { ...sessionView(reference), pinnedAt: '2026-11-01T10:00:00.000Z' };
  }
  async unpin(reference: string): Promise<SessionView> {
    this.calls.push(`unpin ${reference}`);
    return sessionView(reference);
  }
}

const dispatcherFor = (subsystem: SessionPinSubsystem): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(sessionPinRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

const post = (path: string, headers: Readonly<Record<string, string>> = human) =>
  request({ method: 'POST', path, headers, body: '{}' });

describe('the session pin mount', () => {
  it('should pin and unpin for the owner, answering the view', async () => {
    // Arrange
    const subsystem = new FakePins();
    const subject = dispatcherFor(subsystem);

    // Act
    const pinned = await subject.dispatch(post('/v1/sessions/s1/pin'));
    const unpinned = await subject.dispatch(post('/v1/sessions/s1/unpin'));

    // Assert
    should([pinned.status, unpinned.status]).deepEqual([200, 200]);
    should(SessionViewSchema.parse(JSON.parse(pinned.body)).pinnedAt).equal('2026-11-01T10:00:00.000Z');
    should(SessionViewSchema.parse(JSON.parse(unpinned.body))).not.have.property('pinnedAt');
    should(subsystem.calls).deepEqual(['pin s1', 'unpin s1']);
  });

  it('should refuse a ferret, the warden and an anonymous caller before anything is pinned', async () => {
    // Arrange
    const subsystem = new FakePins();
    const subject = dispatcherFor(subsystem);

    // Act
    const ferret = await subject.dispatch(post('/v1/sessions/s1/pin', agentIn('s2')));
    const warden = await subject.dispatch(
      post('/v1/sessions/s1/pin', { authorization: `Bearer ${CREDENTIALS.warden}` }),
    );
    const anonymous = await subject.dispatch(post('/v1/sessions/s1/pin', {}));

    // Assert
    should([ferret.status, warden.status, anonymous.status]).deepEqual([403, 403, 401]);
    should(subsystem.calls).be.empty();
  });

  it('should restate the domain refusals in HTTP, and refuse an unusable id', async () => {
    // Arrange
    const subject = dispatcherFor(new FakePins());

    // Act
    const missing = await subject.dispatch(post('/v1/sessions/ghost/pin'));
    const full = await subject.dispatch(post('/v1/sessions/crowded/pin'));
    const traversal = await subject.dispatch(post('/v1/sessions/%2e%2e%2fetc/pin'));

    // Assert
    should([missing.status, full.status, traversal.status]).deepEqual([404, 409, 400]);
    should((JSON.parse(full.body) as { code: string }).code).equal('pin_limit');
  });

  it('should not dress an unexpected failure up as a domain refusal', async () => {
    // Arrange
    const broken: SessionPinSubsystem = {
      pin: async () => {
        throw new Error('disk gone');
      },
      unpin: async () => sessionView('s1'),
    };
    const subject = dispatcherFor(broken);

    // Act
    const answer = await subject.dispatch(post('/v1/sessions/s1/pin'));

    // Assert
    should(answer.status).equal(500);
  });

  it('should be the owner’s preference: operator scope, person-only, no capability, no-store', () => {
    // Act
    const routes = sessionPinRoutes(new FakePins());

    // Assert
    should(routes.map(route => [route.method, route.path, route.minimum, route.caller, route.noStore])).deepEqual([
      ['POST', '/v1/sessions/:sessionId/pin', 'operator', 'person', true],
      ['POST', '/v1/sessions/:sessionId/unpin', 'operator', 'person', true],
    ]);
    for (const route of routes) should(route).not.have.property('capability');
  });
});
