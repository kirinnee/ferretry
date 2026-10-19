import { describe, it } from 'bun:test';
import { SessionHypermediaPatchResultSchema, type SessionView } from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  type SessionHypermediaSubsystem,
  sessionHypermediaRoutes,
} from '../../../../src/lib/runtime/mounts/session-hypermedia.ts';
import { type HypermediaOutcome, SessionHypermediaError } from '../../../../src/lib/session/hypermedia/service.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, human, sessionView } from './support.ts';

/** The surface a ferret's hypermedia switch is changed through, over the real dispatcher and credentials. */

class FakeHypermedia implements SessionHypermediaSubsystem {
  readonly calls: Array<readonly [string, boolean]> = [];

  constructor(private readonly refusal?: unknown) {}

  async set(
    sessionId: string,
    enabled: boolean,
  ): Promise<{ readonly view: SessionView; readonly outcome: HypermediaOutcome }> {
    this.calls.push([sessionId, enabled]);
    if (this.refusal !== undefined) throw this.refusal;
    return {
      view: sessionView(sessionId, { hypermedia: enabled }),
      outcome: {
        restartRequired: true,
        note: 'Hypermedia is off. This ferret is running, so it takes effect when the ferret restarts.',
      },
    };
  }
}

const dispatcher = (subsystem: SessionHypermediaSubsystem): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(sessionHypermediaRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

const patch = (path: string, body: string): Parameters<ApiDispatcher['dispatch']>[0] =>
  request({ method: 'PATCH', path, headers: human, body });

describe('the session hypermedia mount', () => {
  it('should switch one ferret and answer with its view, whether it needs a restart, and why', async () => {
    // Arrange
    const subsystem = new FakeHypermedia();

    // Act
    const answer = await dispatcher(subsystem).dispatch(patch('/v1/sessions/s1/hypermedia', '{"enabled":false}'));

    // Assert
    should(answer.status).equal(200);
    const result = SessionHypermediaPatchResultSchema.parse(JSON.parse(answer.body));
    should(result.view.config.hypermedia).be.false();
    should(result.restartRequired).be.true();
    should(subsystem.calls).deepEqual([['s1', false]]);
  });

  it('should refuse a body without the switch, and a session that does not exist', async () => {
    // Arrange
    const valid = new FakeHypermedia();
    const missing = new FakeHypermedia(new SessionHypermediaError('not-found', 'no session ghost'));

    // Act
    const bad = await dispatcher(valid).dispatch(patch('/v1/sessions/s1/hypermedia', '{"on":true}'));
    const gone = await dispatcher(missing).dispatch(patch('/v1/sessions/ghost/hypermedia', '{"enabled":true}'));
    const blank = await dispatcher(valid).dispatch(patch('/v1/sessions/%E0%A4%A/hypermedia', '{"enabled":true}'));

    // Assert
    should([bad.status, gone.status]).deepEqual([400, 404]);
    should((JSON.parse(gone.body) as { code: string }).code).equal('not-found');
    should(blank.status).equal(400);
    should(valid.calls).be.empty();
  });

  it('should pass on a fault it does not own', async () => {
    // Arrange
    const subsystem = new FakeHypermedia(new Error('disk full'));

    // Act
    const answer = await dispatcher(subsystem).dispatch(patch('/v1/sessions/s1/hypermedia', '{"enabled":true}'));

    // Assert
    should(answer.status).equal(500);
  });
});
