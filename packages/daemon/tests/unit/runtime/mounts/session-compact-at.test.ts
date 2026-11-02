import { describe, it } from 'bun:test';
import {
  type CompactAt,
  SessionCompactAtPatchResultSchema,
  SessionCompactAtSchema,
  type SessionView,
} from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  type SessionCompactAtSubsystem,
  sessionCompactAtRoutes,
} from '../../../../src/lib/runtime/mounts/session-compact-at.ts';
import { type CompactAtOutcome, SessionCompactAtError } from '../../../../src/lib/session/compact-at/service.ts';
import { request } from '../../api/support.ts';
import { CREDENTIALS, human, sessionView } from './support.ts';

class FakeCompactAt implements SessionCompactAtSubsystem {
  readonly calls: Array<readonly [string, CompactAt | 'inherit' | 'get']> = [];

  constructor(private readonly refusal?: unknown) {}

  async get(sessionId: string) {
    this.calls.push([sessionId, 'get']);
    if (this.refusal !== undefined) throw this.refusal;
    return {
      effective: 'auto' as const,
      window: 1_000_000,
      restartRequired: false,
      note: 'Memory is compacted at the harness’s own trigger (Auto).',
    };
  }

  async set(
    sessionId: string,
    wanted: CompactAt | 'inherit',
  ): Promise<{ readonly view: SessionView; readonly outcome: CompactAtOutcome }> {
    this.calls.push([sessionId, wanted]);
    if (this.refusal !== undefined) throw this.refusal;
    return {
      view: sessionView(sessionId, {}),
      outcome: {
        effective: wanted === 'inherit' ? 'auto' : wanted,
        restartRequired: true,
        note: 'Now memory is compacted at 250k tokens. This ferret is running, so it takes effect when the ferret restarts.',
      },
    };
  }
}

const dispatcher = (subsystem: SessionCompactAtSubsystem): ApiDispatcher =>
  new ApiDispatcher(new ApiRouter(sessionCompactAtRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);

const send = (method: 'GET' | 'PATCH', path: string, body?: string): Parameters<ApiDispatcher['dispatch']>[0] =>
  request({ method, path, headers: human, ...(body === undefined ? {} : { body }) });

describe('the session compact-at mount', () => {
  it('should mount both routes operator-only and uncached', () => {
    // Act
    const routes = sessionCompactAtRoutes(new FakeCompactAt());

    // Assert
    should(routes.map(route => route.method)).deepEqual(['GET', 'PATCH']);
    should(routes.every(route => route.minimum === 'operator' && route.noStore === true)).be.true();
  });

  it('should read the setting', async () => {
    // Act
    const answer = await dispatcher(new FakeCompactAt()).dispatch(send('GET', '/v1/sessions/s1/compact-at'));

    // Assert
    should(answer.status).equal(200);
    should(SessionCompactAtSchema.parse(JSON.parse(answer.body)).effective).equal('auto');
  });

  it('should set a number and say it takes effect at the restart', async () => {
    // Arrange
    const subsystem = new FakeCompactAt();

    // Act
    const answer = await dispatcher(subsystem).dispatch(
      send('PATCH', '/v1/sessions/s1/compact-at', '{"compactAt":250000}'),
    );

    // Assert
    should(answer.status).equal(200);
    const result = SessionCompactAtPatchResultSchema.parse(JSON.parse(answer.body));
    should(result.effective).equal(250_000);
    should(result.restartRequired).be.true();
    should(subsystem.calls).deepEqual([['s1', 250_000]]);
  });

  it('should accept auto and inherit as words', async () => {
    // Arrange
    const subsystem = new FakeCompactAt();

    // Act
    await dispatcher(subsystem).dispatch(send('PATCH', '/v1/sessions/s1/compact-at', '{"compactAt":"auto"}'));
    await dispatcher(subsystem).dispatch(send('PATCH', '/v1/sessions/s1/compact-at', '{"compactAt":"inherit"}'));

    // Assert
    should(subsystem.calls).deepEqual([
      ['s1', 'auto'],
      ['s1', 'inherit'],
    ]);
  });

  it('should refuse a bad body, a small number and a session that does not exist', async () => {
    // Arrange
    const valid = new FakeCompactAt();
    const missing = new FakeCompactAt(new SessionCompactAtError('not-found', 'no session ghost'));
    const tooBig = new FakeCompactAt(new SessionCompactAtError('invalid', '2m is larger than this model’s window'));

    // Act
    const noField = await dispatcher(valid).dispatch(send('PATCH', '/v1/sessions/s1/compact-at', '{}'));
    const small = await dispatcher(valid).dispatch(send('PATCH', '/v1/sessions/s1/compact-at', '{"compactAt":50000}'));
    const gone = await dispatcher(missing).dispatch(send('GET', '/v1/sessions/ghost/compact-at'));
    const refused = await dispatcher(tooBig).dispatch(
      send('PATCH', '/v1/sessions/s1/compact-at', '{"compactAt":2000000}'),
    );
    const blank = await dispatcher(valid).dispatch(send('GET', '/v1/sessions/%E0%A4%A/compact-at'));

    // Assert
    should([noField.status, small.status, gone.status, refused.status, blank.status]).deepEqual([
      400, 400, 404, 400, 400,
    ]);
    should(valid.calls).be.empty();
  });

  it('should pass on a fault it does not own', async () => {
    // Act
    const answer = await dispatcher(new FakeCompactAt(new Error('disk full'))).dispatch(
      send('PATCH', '/v1/sessions/s1/compact-at', '{"compactAt":250000}'),
    );

    // Assert
    should(answer.status).equal(500);
  });
});
