import { describe, it } from 'bun:test';
import type { SessionCompactAt, SessionCompactAtPatch } from '@ferretry/protocol';
import { Command } from 'commander';
import should from 'should';
import {
  type CompactAtChange,
  type ISessionCompactAtGateway,
  ProtocolSessionCompactAtGateway,
  registerSessionCompactAtCommand,
  SessionCompactAtController,
} from '../../../../cli/lib/session/compact-at.ts';
import { SessionCommandError } from '../../../../cli/lib/session/errors.ts';
import { capturedPresenter } from './controller-doubles.ts';
import { sessionView } from './session-fixtures.ts';

/** `fy session compact-at <session> [value]`: what is asked of the daemon, and what a person reads back. */

const READING: SessionCompactAt = {
  effective: 250_000,
  own: 250_000,
  window: 1_000_000,
  restartRequired: false,
  note: 'Memory is compacted at 250k tokens.',
};

function controller() {
  const asked: string[] = [];
  const gateway: ISessionCompactAtGateway = {
    read: async session => {
      asked.push(`read ${session}`);
      return READING;
    },
    write: async (session, change): Promise<CompactAtChange> => {
      asked.push(`write ${session} ${JSON.stringify(change)}`);
      return {
        view: sessionView({ id: 'ses-1' }),
        restartRequired: true,
        note: 'Now memory is compacted at 400k tokens. This ferret is running, so it takes effect when the ferret restarts.',
      };
    },
  };
  const { io, presenter } = capturedPresenter();
  return { asked, io, presenter, subject: new SessionCompactAtController(gateway, presenter) };
}

describe('fy session compact-at', () => {
  it('should show the current value and where it stands when no value is given', async () => {
    // Arrange
    const { asked, io, subject } = controller();

    // Act
    await subject.run(' aniya ', undefined);

    // Assert
    should(asked).deepEqual(['read aniya']);
    should(io.out).deepEqual(['compact at 250k', 'Memory is compacted at 250k tokens.']);
  });

  it('should send a size as tokens, and say the restart note the daemon gave', async () => {
    // Arrange
    const { asked, io, subject } = controller();

    // Act
    await subject.run('aniya', '400k');

    // Assert
    should(asked).deepEqual(['write aniya {"compactAt":400000}']);
    should(io.out).have.length(1);
    should(io.out[0]).containEql('takes effect when the ferret restarts');
  });

  it('should send auto and inherit as words', async () => {
    // Arrange
    const { asked, subject } = controller();

    // Act
    await subject.run('aniya', 'AUTO');
    await subject.run('aniya', ' inherit ');

    // Assert
    should(asked).deepEqual(['write aniya {"compactAt":"auto"}', 'write aniya {"compactAt":"inherit"}']);
  });

  it('should refuse a bad value before calling the daemon, in plain words', async () => {
    // Arrange
    const { asked, subject } = controller();

    // Act
    const small = await subject.run('aniya', '50k').catch((error: unknown) => error);
    const word = await subject.run('aniya', 'lots').catch((error: unknown) => error);
    const blank = await subject.run('  ', '250k').catch((error: unknown) => error);

    // Assert
    should(small).be.instanceOf(SessionCommandError);
    should((small as Error).message).equal('50k is too small: the lowest is 100k.');
    should((word as Error).message).containEql('Use auto');
    should(blank).be.instanceOf(SessionCommandError);
    should(asked).be.empty();
  });

  it('should print the daemon’s answer as JSON on request', async () => {
    // Arrange
    const { io, subject } = controller();

    // Act
    await subject.run('aniya', undefined, { json: true });

    // Assert
    should((JSON.parse(io.out.join('\n')) as SessionCompactAt).effective).equal(250_000);
  });

  it('should show an inherited value as the default', async () => {
    // Arrange
    const { presenter, io } = capturedPresenter();
    const subject = new SessionCompactAtController(
      {
        read: async () => ({ effective: 'auto', restartRequired: false, note: 'Auto.' }),
        write: async () => READING as never,
      },
      presenter,
    );

    // Act
    await subject.run('aniya', undefined);

    // Assert
    should(io.out[0]).equal('compact at Auto (default)');
  });
});

describe('ProtocolSessionCompactAtGateway', () => {
  it('should resolve the session by name, then read and patch its id', async () => {
    // Arrange
    const calls: string[] = [];
    const gateway = new ProtocolSessionCompactAtGateway({
      get: async (name: string) => {
        calls.push(`get ${name}`);
        return sessionView({ id: 'ses 1' });
      },
      request: async (path: string, _schema: unknown, init?: { method?: string; body?: string }) => {
        calls.push(`${init?.method ?? 'GET'} ${path} ${init?.body ?? ''}`.trim());
        return init?.method === 'PATCH'
          ? {
              view: sessionView({ id: 'ses 1' }),
              effective: 250_000,
              restartRequired: true,
              note: 'Now 250k.',
            }
          : READING;
      },
    } as never);

    // Act
    await gateway.read('aniya');
    const change: SessionCompactAtPatch = { compactAt: 250_000 };
    const written = await gateway.write('aniya', change);

    // Assert
    should(calls).deepEqual([
      'get aniya',
      'GET /v1/sessions/ses%201/compact-at',
      'get aniya',
      'PATCH /v1/sessions/ses%201/compact-at {"compactAt":250000}',
    ]);
    should(written.restartRequired).be.true();
  });
});

describe('registerSessionCompactAtCommand', () => {
  it('should be reachable as `session compact-at <session> [value]` beside the other session verbs', async () => {
    // Arrange
    const { asked, subject, presenter } = controller();
    const program = new Command().exitOverride();
    program
      .command('session')
      .command('pin')
      .action(() => undefined);
    registerSessionCompactAtCommand(program, subject, presenter);

    // Act
    await program.parseAsync(['session', 'compact-at', 'aniya', '250k'], { from: 'user' });

    // Assert
    should(asked).deepEqual(['write aniya {"compactAt":250000}']);
    should(program.commands.filter(command => command.name() === 'session')).have.length(1);
  });

  it('should report a usage refusal on stderr with the usage exit code', async () => {
    // Arrange
    const { io, subject, presenter } = controller();
    const program = new Command().exitOverride();
    registerSessionCompactAtCommand(program, subject, presenter);

    // Act
    await program.parseAsync(['session', 'compact-at', 'aniya', '10k'], { from: 'user' });

    // Assert
    should(io.err).deepEqual(['10k is too small: the lowest is 100k.']);
    should(io.exitCode).equal(2);
  });
});
