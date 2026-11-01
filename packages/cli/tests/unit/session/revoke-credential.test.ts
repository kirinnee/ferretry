import { describe, it } from 'bun:test';
import { SessionCredentialRevokedSchema, type SessionStatus } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import { SessionCommandError } from '../../../src/lib/session/errors.ts';
import {
  ProtocolSessionCredentialGateway,
  RevokeCredentialController,
  registerSessionCredentialCommands,
} from '../../../src/lib/session/revoke-credential.ts';
import { capturedPresenter } from './controller-doubles.ts';

/** `fy session revoke-credential <session>`: what is sent, and what a person reads back. */

function controller(status: SessionStatus = 'running') {
  const asked: string[] = [];
  const gateway = {
    revoke: async (session: string) => {
      asked.push(session);
      return { sessionId: 'ms8-abcd1234', status };
    },
  };
  const { io, presenter } = capturedPresenter();
  return { asked, io, presenter, subject: new RevokeCredentialController(gateway, presenter, 'fy') };
}

describe('fy session revoke-credential', () => {
  it('should say what is cut off, that it sticks until a person resumes it, and what it does not reach', async () => {
    // Arrange
    const { asked, io, subject } = controller('thinking');

    // Act
    await subject.execute(' aniya ');

    // Assert
    should(asked).deepEqual(['aniya']);
    should(io.out).deepEqual([
      "revoked ms8-abcd1234's credential: where its fy, MCP server and tools present their own (fys_…), they are refused from now on",
      'no restart, revive or migration gives it a credential again until a person resumes it: fy resume ms8-abcd1234',
      'it keeps running; a pane still on the admin token (an older fy, or one that read api-token) is not cut off by this — to stop it too: fy stop ms8-abcd1234',
    ]);
  });

  it('should say only its status for a session with no pane', async () => {
    // Arrange
    const { io, subject } = controller('stopped');

    // Act
    await subject.execute('ms8-abcd1234');

    // Assert
    should(io.out[2]).equal('it is stopped');
  });

  it('should print the answer as JSON on request, and nothing secret is in it', async () => {
    // Arrange
    const { io, subject } = controller();

    // Act
    await subject.execute('ms8-abcd1234', { json: true });

    // Assert
    should(SessionCredentialRevokedSchema.parse(JSON.parse(io.out.join('\n')))).deepEqual({
      sessionId: 'ms8-abcd1234',
      status: 'running',
    });
  });

  it('should refuse an empty session before calling the daemon', async () => {
    // Arrange
    const { asked, subject } = controller();

    // Act
    const failure = await subject.execute('  ').catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(SessionCommandError);
    should(asked).be.empty();
  });

  it('should POST the revoke route for the named session, with no body', async () => {
    // Arrange
    const calls: Array<readonly [string, RequestInit | undefined]> = [];
    const gateway = new ProtocolSessionCredentialGateway({
      request: async (path, schema, init) => {
        calls.push([path, init]);
        return schema.parse({ sessionId: 'ms8-abcd1234', status: 'running' });
      },
    });

    // Act
    await gateway.revoke('mary jane');

    // Assert
    should(calls).deepEqual([['/v1/sessions/mary%20jane/revoke-credential', { method: 'POST' }]]);
  });

  it('should be reachable as `session revoke-credential <session>` and report a refusal on stderr', async () => {
    // Arrange
    const { io, presenter } = capturedPresenter();
    const refusing = new RevokeCredentialController(
      {
        revoke: async () => {
          throw new Error('only a person may do this; ask the owner');
        },
      },
      presenter,
      'fy',
    );
    const program = new Command().exitOverride();
    registerSessionCredentialCommands(program, refusing, presenter);

    // Act
    await program.parseAsync(['session', 'revoke-credential', 'aniya'], { from: 'user' });

    // Assert
    should(io.err).deepEqual(['only a person may do this; ask the owner']);
    should(io.exitCode).equal(1);
  });
});
