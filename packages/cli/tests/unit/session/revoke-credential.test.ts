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
  it('should say a running ferret is cut off now, keeps running until its next launch, and how to keep it off', async () => {
    // Arrange
    const { asked, io, subject } = controller('thinking');

    // Act
    await subject.execute(' aniya ');

    // Assert
    should(asked).deepEqual(['aniya']);
    should(io.out).deepEqual([
      "revoked ms8-abcd1234's credential: its fy, MCP server and tools are refused from now on",
      'it keeps running without them until its next launch, which gets a fresh credential; to keep it off: fy stop ms8-abcd1234',
    ]);
  });

  it('should say a stopped session gets a fresh credential at its next launch', async () => {
    // Arrange
    const { io, subject } = controller('stopped');

    // Act
    await subject.execute('ms8-abcd1234');

    // Assert
    should(io.out[1]).equal('it is stopped; its next launch gets a fresh credential');
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
