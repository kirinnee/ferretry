import { describe, it } from 'bun:test';
import { emptyChildEnvironment, fenced, ferretId } from '@ferretry/core-ferrets/contract/testing';
import should from 'should';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import type { TmuxCommandResult } from '../../../../daemon/lib/tmux/contracts.ts';

const done = (stdout = ''): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });
const noServer: TmuxCommandResult = { code: 1, stdout: '', stderr: 'no server running on /fixture/tmux.sock' };

/**
 * A tmux whose server behaves as the real one does with `exit-empty on`: it lives only while a client command
 * is running or a session exists. `start-server` starts one; a command with no server running fails; and when
 * a client's commands are done with no session, the server exits.
 */
class DyingServer {
  running = false;
  exitEmpty = 'on';
  readonly sessions = new Set<string>();
  readonly invocations: Array<readonly string[]> = [];
  /** Whether a server STARTED by the script-running client (the one that holds a ferret's values) ever happened. */
  startedByValueHoldingClient = false;

  private commandsOf(args: readonly string[]): string[][] {
    const commands: string[][] = [[]];
    for (const arg of args) {
      if (arg === ';') commands.push([]);
      else commands.at(-1)?.push(arg);
    }
    return commands;
  }

  /** One client process: its commands in order, the first failure ending it; then the server exits if it is empty. */
  private client(commands: readonly (readonly string[])[], holdsValues: boolean): TmuxCommandResult {
    let stdout = '';
    let failure: TmuxCommandResult | undefined;
    for (const [name = '', ...rest] of commands) {
      if (name === 'start-server') {
        if (!this.running && holdsValues) this.startedByValueHoldingClient = true;
        this.running = true;
        continue;
      }
      if (!this.running) {
        failure = noServer;
        break;
      }
      if (name === 'show-options') {
        const option = rest.at(-1);
        stdout += option === 'exit-empty' ? `${this.exitEmpty}\n` : 'PATH\nTERM\n';
      } else if (name === 'set-option') {
        if (rest[0] === '-s' && rest[1] === 'exit-empty') this.exitEmpty = rest[2] ?? '';
      } else if (name === 'new-session') {
        this.sessions.add(rest[rest.indexOf('-s') + 1] ?? '');
        stdout += '%9|4242\n';
      } else if (name === 'has-session') {
        if (!this.sessions.has(rest[rest.indexOf('-t') + 1] ?? ''))
          failure = { ...noServer, stderr: "can't find session" };
      }
      if (failure !== undefined) break;
    }
    if (this.running && this.sessions.size === 0 && this.exitEmpty === 'on') this.running = false;
    return failure ?? done(stdout);
  }

  execute = async (args: readonly string[]): Promise<TmuxCommandResult> => {
    this.invocations.push(args);
    return this.client(this.commandsOf(args), false);
  };

  /** `tmux -u -S socket <args>` with the script on stdin, run by the client that holds a ferret's values. */
  run = async (args: readonly string[], script: string | undefined): Promise<TmuxCommandResult> => {
    this.invocations.push(args);
    const afterSocket = args.slice(args.indexOf('-S') + 2);
    const fromScript = (script ?? '')
      .split('\n')
      .filter(line => line !== '')
      .map(line => [...line.matchAll(/'((?:[^']|'"'"')*)'/gu)].map(([, word = '']) => word.replaceAll(`'"'"'`, "'")));
    const commands = this.commandsOf(afterSocket).flatMap(command =>
      command[0] === 'source-file' ? fromScript : [command],
    );
    return this.client(commands, true);
  };
}

function launching(server: DyingServer) {
  const runner = new TmuxRunner({
    tmux: { execute: server.execute },
    spawn: {
      run: async (_program, args, options) => {
        const result = await server.run(args, options?.stdin as string | undefined);
        return { exitCode: result.code, signal: null, stdout: result.stdout, stderr: result.stderr };
      },
      runBytes: () => Promise.reject(new Error('not used')),
      start: () => {
        throw new Error('not used');
      },
    },
    socketPath: '/fixture/tmux.sock',
    instantOf: () => 'then' as never,
    now: () => 'now' as never,
  });
  const spec = {
    ferret: ferretId('f1'),
    command: ['harness', '--flag'],
    cwd: fenced('/work'),
    env: emptyChildEnvironment(),
  };
  return { runner, spec };
}

describe('TmuxRunner first launch on a server that exits when empty', () => {
  it('should start the first ferret even though no session keeps the server up between the launch’s own clients', async () => {
    // Arrange
    const server = new DyingServer();
    const world = launching(server);

    // Act
    const started = await world.runner.start(world.spec);

    // Assert
    should(started.ok ? 'started' : started.error).equal('started');
    should([...server.sessions]).deepEqual(['fy-f1']);
  });

  it('should never let the client that holds the ferret’s values be the one that starts the server', async () => {
    // Arrange
    const server = new DyingServer();
    const world = launching(server);

    // Act
    await world.runner.start(world.spec);

    // Assert
    should(server.startedByValueHoldingClient).equal(false);
  });

  it('should put the server’s exit-empty back once the session holds it up', async () => {
    // Arrange
    const server = new DyingServer();
    const world = launching(server);

    // Act
    await world.runner.start(world.spec);

    // Assert
    should(server.exitEmpty).equal('on');
    should(server.running).equal(true);
  });

  it('should put exit-empty back, and leave no server behind, when the new session was not made', async () => {
    // Arrange
    const server = new DyingServer();
    const world = launching(server);
    server.run = async args => {
      // The script's client fails before it makes a session.
      server.invocations.push(args);
      return { code: 1, stdout: '', stderr: 'create session failed' };
    };

    // Act
    const started = await world.runner.start(world.spec);

    // Assert
    should(started.ok ? undefined : started.error).equal('failed');
    should(server.exitEmpty).equal('on');
    should(server.running).equal(false);
  });
});
