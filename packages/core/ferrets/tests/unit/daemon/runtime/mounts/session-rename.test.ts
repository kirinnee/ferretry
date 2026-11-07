import { describe, it } from 'bun:test';
import { type RenameSessionRequest, type SessionView, SessionViewSchema } from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { SessionRenameError } from '../../../../src/lib/names/index.ts';
import { type SessionRenameSubsystem, sessionRenameRoutes } from '../../../../src/lib/runtime/mounts/session-rename.ts';
import { request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, human, sessionView } from './support.ts';

/**
 * The surface an agent is renamed through. Every case goes through the real dispatcher and the real
 * credentials, because what this mount owes the domain is a validated request from an authorized
 * caller, attributed to the actor the boundary derived.
 */

class FakeRename implements SessionRenameSubsystem {
  readonly renames: Array<readonly [string, RenameSessionRequest, string]> = [];

  constructor(private readonly refusals: Readonly<Record<string, unknown>> = {}) {}

  async rename(sessionId: string, body: RenameSessionRequest, actor: string): Promise<SessionView> {
    this.renames.push([sessionId, body, actor]);
    const refusal = this.refusals[sessionId];
    if (refusal !== undefined) throw refusal;
    return sessionView(sessionId, { teammate: body.teammate?.toLowerCase() ?? 'hadi' });
  }
}

function dispatcher(subsystem: SessionRenameSubsystem): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(sessionRenameRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

function renameRequest(
  sessionId: string,
  body: string,
  headers: Readonly<Record<string, string>> = human,
): Parameters<ApiDispatcher['dispatch']>[0] {
  return request({ method: 'POST', path: `/v1/sessions/${sessionId}/rename`, headers, body });
}

const codeOf = (body: string): string => (JSON.parse(body) as { code: string }).code;

describe('the session rename mount', () => {
  it('should rename an agent and answer with the view the read surface serves, attributed to its actor', async () => {
    // Arrange
    const subsystem = new FakeRename();
    const subject = dispatcher(subsystem);

    // Act
    const fromCli = await subject.dispatch(renameRequest('s1', JSON.stringify({ teammate: ' Marin ', name: 'Ship' })));
    const fromAgent = await subject.dispatch(renameRequest('s2', JSON.stringify({ name: 'Mine' }), agentIn('s2')));

    // Assert
    should([fromCli.status, fromAgent.status]).deepEqual([200, 200]);
    should(SessionViewSchema.parse(JSON.parse(fromCli.body)).config.teammate).equal('marin');
    should(subsystem.renames).deepEqual([
      ['s1', { teammate: 'Marin', name: 'Ship' }, 'admin-cli'],
      ['s2', { name: 'Mine' }, 'peer:s2'],
    ]);
  });

  it('should refuse a name outside the grammar and an empty request before the domain sees them', async () => {
    // Arrange
    const subsystem = new FakeRename();
    const subject = dispatcher(subsystem);

    // Act
    const answers = await Promise.all(
      ['{"teammate":"Mary Jane"}', '{"teammate":"7up"}', '{}', '{"nickname":"x"}', ''].map(
        async body => await subject.dispatch(renameRequest('s1', body)),
      ),
    );

    // Assert
    should(answers.map(answer => answer.status)).deepEqual([400, 400, 400, 400, 400]);
    should(subsystem.renames).be.empty();
  });

  it('should answer each rename refusal with its own status and code, and let a defect stay a defect', async () => {
    // Arrange
    const subject = dispatcher(
      new FakeRename({
        bad: new SessionRenameError('invalid', 'a task title must contain printable text'),
        ghost: new SessionRenameError('not_found', 'no session ghost'),
        taken: new SessionRenameError('taken', 'another agent on this machine is already called Marin'),
        orphan: new SessionRenameError('unsupported', 'a rename cannot detach a session from its parent'),
        ledger: new SessionRenameError('unavailable', 'callsign persistence failed'),
        disk: new SessionRenameError('failed', 'disk full'),
        broken: new Error('the storage index was closed'),
      }),
    );

    // Act
    const answers = await Promise.all(
      ['bad', 'ghost', 'taken', 'orphan', 'ledger', 'disk', 'broken'].map(
        async id => await subject.dispatch(renameRequest(id, JSON.stringify({ teammate: 'marin' }))),
      ),
    );

    // Assert
    should(answers.slice(0, 6).map(answer => [answer.status, codeOf(answer.body)])).deepEqual([
      [400, 'invalid_request'],
      [404, 'not-found'],
      [409, 'name_taken'],
      [400, 'rename_unsupported'],
      [503, 'name_unavailable'],
      [500, 'session_rename_failed'],
    ]);
    should(JSON.parse(answers[2]?.body ?? '{}')).have.property(
      'error',
      'another agent on this machine is already called Marin',
    );
    should(answers[6]?.status).equal(500);
    should(answers[6]?.body).not.match(/storage index/u);
  });

  it('should refuse anonymously, refuse a warden token, and refuse a path that regains a separator', async () => {
    // Arrange
    const subsystem = new FakeRename();
    const subject = dispatcher(subsystem);
    const body = JSON.stringify({ teammate: 'marin' });

    // Act
    const anonymous = await subject.dispatch(renameRequest('s1', body, {}));
    const warden = await subject.dispatch(renameRequest('s1', body, { authorization: `Bearer ${CREDENTIALS.warden}` }));
    const traversal = await subject.dispatch(renameRequest('%2e%2e%2fetc', body));

    // Assert
    should([anonymous.status, warden.status, traversal.status]).deepEqual([401, 403, 400]);
    should(codeOf(traversal.body)).equal('invalid_session_id');
    should(subsystem.renames).be.empty();
  });

  it('should be operator scope and no-store', () => {
    // Act
    const routes = sessionRenameRoutes(new FakeRename());

    // Assert
    should(routes.map(route => [route.method, route.path, route.minimum, route.noStore])).deepEqual([
      ['POST', '/v1/sessions/:sessionId/rename', 'operator', true],
    ]);
  });
});
