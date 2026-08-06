import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { FyTaskBoardGateway, TASK_BOARD_ROUTE_PREFIX } from '../../../src/adapters/tasks/fy-task-board-gateway';
import { registerTaskBoardCommands } from '../../../src/adapters/tasks/task-board-commands';
import type { TaskBoardCommand } from '../../../src/lib/task-boards/board-command';
import type { ITaskBoardGateway } from '../../../src/lib/task-boards/board-controller';
import {
  FY_BOARD_ADMIN_CAPABILITY_HEADER,
  FY_BOARD_CAPABILITY_HEADER,
  type TaskBoardCredentials,
} from '../../../src/lib/task-boards/board-credentials';
import type { ITaskOutput } from '../../../src/lib/tasks/ports';
import { fakeClient } from '../tasks/fake-daemon';

const membership = {
  sessionId: 's-1',
  role: 'worker',
  allowedActions: ['read', 'note'],
  boardEpoch: 1,
  coordinatorEpoch: 1,
  runtimeGeneration: 1,
};

const grantRequest = {
  requestId: 'g-1',
  targetSessionId: 'child-1',
  requestedRole: 'read',
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
};

const invitation = {
  requestId: 'i-1',
  sourceSessionId: 's-1',
  targetSessionId: 's-9',
  status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
};

describe('the board gateway', () => {
  it('should GET the membership read and carry the peer proof', async () => {
    // Arrange
    const { client, transport } = fakeClient([membership]);
    const gateway = new FyTaskBoardGateway(await client);

    // Act
    const actual = await gateway.send({ command: 'membership' }, { [FY_BOARD_CAPABILITY_HEADER]: 'peer-proof' });

    // Assert
    should(actual).have.property('role', 'worker');
    should(transport.exchanges[0]?.method).equal('GET');
    should(transport.exchanges[0]?.url).endWith(`${TASK_BOARD_ROUTE_PREFIX}/membership`);
  });

  it('should POST each mutation to its own route', async () => {
    // Arrange
    const commands: readonly [TaskBoardCommand, unknown, string][] = [
      [
        { command: 'create', body: { creatorSessionId: 's-1', coordinatorSessionId: 's-2', creatorMarkDone: false } },
        { created: true, creator: membership, coordinator: membership },
        '/create',
      ],
      [
        { command: 'grant-request', body: { targetSessionId: 'child-1', role: 'read' } },
        grantRequest,
        '/child-grants/request',
      ],
      [{ command: 'grant-approve', body: { grantRequestId: 'g-1' } }, grantRequest, '/child-grants/approve'],
      [{ command: 'invite', body: { targetSessionId: 's-9' } }, invitation, '/invitations/request'],
      [{ command: 'invite-approve', body: { invitationRequestId: 'i-1' } }, invitation, '/invitations/approve'],
      [{ command: 'invite-accept' }, membership, '/invitations/accept'],
      [{ command: 'invite-verify' }, membership, '/invitations/verify'],
      [
        { command: 'relinquish' },
        { relinquished: true, sessionId: 's-1', sessionStopped: false },
        '/membership/relinquish',
      ],
      [{ command: 'mark-done', body: { sessionId: 's-1', enabled: true } }, membership, '/mark-done'],
      [
        {
          command: 'coordinator-replace',
          body: {
            requestId: 'replace-1',
            sessionId: 's-1',
            replacementSessionId: 's-2',
            replacementRootSessionId: 'root-2',
          },
        },
        membership,
        '/coordinator/replace',
      ],
      [
        { command: 'revoke', body: { sessionId: 's-1', targetSessionId: 's-2', reason: 'left' } },
        { revoked: true, targetSessionId: 's-2' },
        '/grants/revoke',
      ],
    ];

    // Act + Assert
    for (const [command, reply, path] of commands) {
      const { client, transport } = fakeClient([reply]);
      await new FyTaskBoardGateway(await client).send(command, {});
      should(transport.exchanges[0]?.method).equal('POST');
      should(transport.exchanges[0]?.url).endWith(`${TASK_BOARD_ROUTE_PREFIX}${path}`);
    }
  });

  it('should reject a response that does not match its wire schema', async () => {
    // Arrange
    const { client } = fakeClient([{ role: 'sysadmin' }]);
    const gateway = new FyTaskBoardGateway(await client);

    // Act + Assert
    await should(gateway.send({ command: 'membership' }, {})).be.rejected();
  });

  it('should not touch the daemon until a command needs it', async () => {
    // Arrange
    const { client, transport } = fakeClient([membership]);

    // Act
    new FyTaskBoardGateway(await client);

    // Assert
    should(transport.exchanges).have.length(0);
  });
});

class RecordingGateway implements ITaskBoardGateway {
  sent: TaskBoardCommand | undefined;
  headers: Readonly<Record<string, string>> | undefined;

  send(command: TaskBoardCommand, headers: Readonly<Record<string, string>>): Promise<unknown> {
    this.sent = command;
    this.headers = headers;
    return Promise.resolve({ ok: true, capability: 'never-print-me' });
  }
}

class CapturedOutput implements ITaskOutput {
  readonly lines: string[] = [];

  success(message: string): void {
    this.lines.push(message);
  }
}

function harness(credentials: TaskBoardCredentials) {
  const gateway = new RecordingGateway();
  const output = new CapturedOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerTaskBoardCommands(program, { gateway, io: output, credentials });
  return {
    gateway,
    output,
    run: async (...argv: string[]) => {
      await program.parseAsync(['node', 'fy', 'task-board', ...argv]);
    },
  };
}

const everyProof: TaskBoardCredentials = {
  peer: 'peer-proof',
  admin: 'admin-proof',
  session: 'session-proof',
  invitation: 'invite-proof',
};

describe('fy task-board', () => {
  it('should read membership and print the redacted answer', async () => {
    // Arrange
    const { run, gateway, output } = harness(everyProof);

    // Act
    await run('membership');

    // Assert
    should(gateway.sent).eql({ command: 'membership' });
    should(gateway.headers).eql({ [FY_BOARD_CAPABILITY_HEADER]: 'peer-proof' });
    should(output.lines[0]).not.containEql('never-print-me');
    should(output.lines[0]).containEql('"ok": true');
  });

  it('should build a create from its two required sessions', async () => {
    // Arrange
    const { run, gateway } = harness(everyProof);

    // Act
    await run('create', '--creator', 's-1', '--coordinator', 's-2', '--mark-done');

    // Assert
    should(gateway.sent).eql({
      command: 'create',
      body: { creatorSessionId: 's-1', coordinatorSessionId: 's-2', creatorMarkDone: true },
    });
    should(gateway.headers).eql({ [FY_BOARD_ADMIN_CAPABILITY_HEADER]: 'admin-proof' });
  });

  it('should build the grant and invitation flow', async () => {
    // Arrange
    const request = harness(everyProof);
    const approve = harness(everyProof);
    const invite = harness(everyProof);
    const inviteApprove = harness(everyProof);
    const accept = harness(everyProof);
    const verify = harness(everyProof);
    const relinquish = harness(everyProof);

    // Act
    await request.run('grant-request', 'child-1', '--role', 'worker');
    await approve.run('grant-approve', 'g-1');
    await invite.run('invite', 's-9');
    await inviteApprove.run('invite-approve', 'i-1');
    await accept.run('invite-accept');
    await verify.run('invite-verify');
    await relinquish.run('relinquish');

    // Assert
    should(request.gateway.sent).eql({
      command: 'grant-request',
      body: { targetSessionId: 'child-1', role: 'worker' },
    });
    should(approve.gateway.sent).eql({ command: 'grant-approve', body: { grantRequestId: 'g-1' } });
    should(invite.gateway.sent).eql({ command: 'invite', body: { targetSessionId: 's-9' } });
    should(inviteApprove.gateway.sent).eql({ command: 'invite-approve', body: { invitationRequestId: 'i-1' } });
    should(accept.gateway.sent).eql({ command: 'invite-accept' });
    should(verify.gateway.sent).eql({ command: 'invite-verify' });
    should(relinquish.gateway.sent).eql({ command: 'relinquish' });
  });

  it('should build the operator commands', async () => {
    // Arrange
    const markDone = harness(everyProof);
    const replace = harness(everyProof);
    const revoke = harness(everyProof);

    // Act
    await markDone.run('mark-done', 's-1', '--disable');
    await replace.run('coordinator-replace', 's-1', 's-2', 'root-2');
    await revoke.run('revoke', 's-1', 's-2', '--reason', 'left the project');

    // Assert
    should(markDone.gateway.sent).eql({ command: 'mark-done', body: { sessionId: 's-1', enabled: false } });
    // The replacement command generates its own nonblank requestId (board-command.ts), so match it
    // rather than asserting a fixed value; replacementRootSessionId is the fixed root passed in.
    should(replace.gateway.sent).match({
      command: 'coordinator-replace',
      body: {
        requestId: /^[0-9a-f-]+$/,
        sessionId: 's-1',
        replacementSessionId: 's-2',
        replacementRootSessionId: 'root-2',
      },
    });
    should(revoke.gateway.sent).eql({
      command: 'revoke',
      body: { sessionId: 's-1', targetSessionId: 's-2', reason: 'left the project' },
    });
  });

  it('should refuse an operator command when only a peer binding is present', async () => {
    // Arrange
    const { run, gateway } = harness({ peer: 'peer-proof' });

    // Act + Assert
    await should(run('mark-done', 's-1', '--enable')).be.rejectedWith(/FY_BOARD_ADMIN_CAPABILITY/u);
    should(gateway.sent).be.undefined();
  });

  it('should refuse mark-done that names neither or both switches', async () => {
    // Arrange
    const neither = harness(everyProof);
    const both = harness(everyProof);

    // Act + Assert
    await should(neither.run('mark-done', 's-1')).be.rejectedWith(/exactly one of/u);
    await should(both.run('mark-done', 's-1', '--enable', '--disable')).be.rejectedWith(/exactly one of/u);
  });

  it('should refuse a grant request with an unknown role', async () => {
    // Arrange
    const { run } = harness(everyProof);

    // Act + Assert
    await should(run('grant-request', 'child-1', '--role', 'admin')).be.rejectedWith(/--role must be one of/u);
  });

  it('should have no way to name a board', async () => {
    // Arrange
    const { run } = harness(everyProof);

    // Act + Assert — commander refuses the flag outright; there is no board id in the surface.
    await should(run('membership', '--board', 'b-1')).be.rejected();
  });
});
