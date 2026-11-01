import { describe, it } from 'bun:test';
import { type SessionCredentialRevoked, SessionCredentialRevokedSchema } from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  SessionCredentialError,
  type SessionCredentialSubsystem,
  sessionCredentialRoutes,
} from '../../../../src/lib/runtime/mounts/session-credential.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, FERRET_SESSION, fromFerret, human } from './support.ts';

/**
 * Cutting a ferret off (`POST /v1/sessions/:sessionId/revoke-credential`, docs/agent-tools.md): a person's act,
 * through the real dispatcher and credentials, so who may call it is decided exactly as the daemon decides it.
 */

class FakeRevocation implements SessionCredentialSubsystem {
  readonly revoked: string[] = [];

  async revoke(sessionId: string): Promise<SessionCredentialRevoked> {
    if (sessionId !== 'ms8-abcd1234') throw new SessionCredentialError('not_found', `no session ${sessionId}`);
    this.revoked.push(sessionId);
    return { sessionId, status: 'running' };
  }
}

function dispatcher(subsystem: SessionCredentialSubsystem): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(sessionCredentialRoutes(subsystem)), CREDENTIALS, NO_GOVERNED_ROUTES_GUARD);
}

const revoke = (sessionId: string, headers: Readonly<Record<string, string>> = human) =>
  request({ method: 'POST', path: `/v1/sessions/${sessionId}/revoke-credential`, headers });

describe('cutting a ferret off', () => {
  it('should revoke the session’s credential for the owner, answering its id and status and nothing secret', async () => {
    // Arrange
    const subsystem = new FakeRevocation();

    // Act
    const answer = await dispatcher(subsystem).dispatch(revoke('ms8-abcd1234'));

    // Assert
    should(answer.status).equal(200);
    should(SessionCredentialRevokedSchema.parse(jsonBody(answer))).deepEqual({
      sessionId: 'ms8-abcd1234',
      status: 'running',
    });
    should(subsystem.revoked).deepEqual(['ms8-abcd1234']);
  });

  it('should refuse a ferret, on its own credential or the admin token with its header, before anything is revoked', async () => {
    // Arrange — its own session, and a peer's: a prompt-injected ferret cannot knock others off either.
    const subsystem = new FakeRevocation();
    const on = dispatcher(subsystem);

    // Act
    const answers = [
      await on.dispatch(fromFerret(revoke(FERRET_SESSION))),
      await on.dispatch(fromFerret(revoke('ms8-abcd1234'))),
      await on.dispatch(revoke('ms8-abcd1234', agentIn(FERRET_SESSION))),
    ];

    // Assert
    should(answers.map(answer => [answer.status, jsonBody(answer).code])).deepEqual([
      [403, 'owner_only'],
      [403, 'owner_only'],
      [403, 'owner_only'],
    ]);
    should(subsystem.revoked).be.empty();
  });

  it('should answer 404 for a session that does not exist', async () => {
    // Act
    const answer = await dispatcher(new FakeRevocation()).dispatch(revoke('ms8-nobody000'));

    // Assert
    should([answer.status, jsonBody(answer).code]).deepEqual([404, 'not-found']);
  });
});
