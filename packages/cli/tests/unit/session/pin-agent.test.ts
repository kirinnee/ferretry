import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { SessionCommandError } from '../../../src/lib/session/errors.ts';
import {
  PinAgentController,
  ProtocolSessionPinGateway,
  registerSessionPinCommands,
} from '../../../src/lib/session/pin-agent.ts';
import { capturedPresenter } from './controller-doubles.ts';
import { sessionView } from './session-fixtures.ts';

/** `fy session pin|unpin <session>`: what is asked of the daemon, and what a person reads back. */

function controller() {
  const asked: string[] = [];
  const gateway = {
    pin: async (session: string) => {
      asked.push(`pin ${session}`);
      return { ...sessionView({ id: 'ses-1', teammate: 'Aniya' }), pinnedAt: '2026-11-01T10:00:00.000Z' };
    },
    unpin: async (session: string) => {
      asked.push(`unpin ${session}`);
      return sessionView({ id: 'ses-1', teammate: 'Aniya' });
    },
  };
  const { io, presenter } = capturedPresenter();
  return { asked, io, presenter, subject: new PinAgentController(gateway, presenter) };
}

describe('fy session pin and unpin', () => {
  it('should pin and unpin the named session and say so', async () => {
    // Arrange
    const { asked, io, subject } = controller();

    // Act
    await subject.pin(' aniya ');
    await subject.unpin('ses-1');

    // Assert
    should(asked).deepEqual(['pin aniya', 'unpin ses-1']);
    should(io.out).deepEqual(['pinned Aniya (ses-1) to the top of the sidebar', 'unpinned Aniya (ses-1)']);
  });

  it('should print the session as JSON on request, pin included', async () => {
    // Arrange
    const { io, subject } = controller();

    // Act
    await subject.pin('aniya', { json: true });

    // Assert
    should((JSON.parse(io.out.join('\n')) as { pinnedAt: string }).pinnedAt).equal('2026-11-01T10:00:00.000Z');
  });

  it('should refuse an empty session before calling the daemon', async () => {
    // Arrange
    const { asked, subject } = controller();

    // Act
    const failure = await subject.pin('  ').catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(SessionCommandError);
    should(asked).be.empty();
  });

  it('should reach the protocol client’s pin and unpin', async () => {
    // Arrange
    const calls: string[] = [];
    const gateway = new ProtocolSessionPinGateway({
      pinSession: async id => {
        calls.push(`pin ${id}`);
        return sessionView({ id });
      },
      unpinSession: async id => {
        calls.push(`unpin ${id}`);
        return sessionView({ id });
      },
    });

    // Act
    await gateway.pin('a');
    await gateway.unpin('b');

    // Assert
    should(calls).deepEqual(['pin a', 'unpin b']);
  });

  it('should be reachable as `session pin <session>` beside the other session verbs, and report a refusal on stderr', async () => {
    // Arrange
    const { io, presenter } = capturedPresenter();
    const refusing = new PinAgentController(
      {
        pin: async () => {
          throw new Error('only a person may do this');
        },
        unpin: async () => sessionView({ id: 'ses-1' }),
      },
      presenter,
    );
    const program = new Command().exitOverride();
    program
      .command('session')
      .command('revoke-credential')
      .action(() => undefined);
    registerSessionPinCommands(program, refusing, presenter);

    // Act
    await program.parseAsync(['session', 'pin', 'aniya'], { from: 'user' });

    // Assert
    should(io.err).deepEqual(['only a person may do this']);
    should(io.exitCode).equal(1);
    should(program.commands.filter(command => command.name() === 'session')).have.length(1);
  });

  it('should create the `session` command itself when nothing registered it first', async () => {
    // Arrange
    const { asked, subject, presenter } = controller();
    const program = new Command().exitOverride();
    registerSessionPinCommands(program, subject, presenter);

    // Act
    await program.parseAsync(['session', 'unpin', 'ses-1'], { from: 'user' });

    // Assert
    should(asked).deepEqual(['unpin ses-1']);
    should(program.commands.map(command => command.name())).deepEqual(['session']);
  });
});
