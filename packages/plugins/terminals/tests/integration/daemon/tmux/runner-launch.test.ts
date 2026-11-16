import { describe, it } from 'bun:test';
import type { RunnerHandle } from '@ferretry/core-ferrets/contract';
import { emptyChildEnvironment, fenced, ferretId } from '@ferretry/core-ferrets/contract/testing';
import should from 'should';
import { TmuxRunner } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import type { TmuxCommandResult } from '../../../../daemon/lib/tmux/contracts.ts';
import { RealHarnessRefusedError, type TmuxLaunchGuard } from '../../../../daemon/lib/tmux/index.ts';
import { scriptWords } from '../support/script-words.ts';
import { subject } from './runner-world.ts';

const done = (stdout = ''): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });
const refused = (stderr: string): TmuxCommandResult => ({ code: 1, stdout: '', stderr });

/** `#{pane_id}|#{pane_pid}|#{pane_dead}|#{session_name}|#{session_created}|#{pane_current_command}|#{cursor_y}` */
const facts = (session: string, dead = false): string => `%9|4242|${dead ? 1 : 0}|${session}|1000|harness|3\n`;

/** A runner over a scripted tmux and spawn: every command it sends is recorded, and what the launch script made is `created`. */
function launching(
  options: {
    readonly sessionExists?: boolean;
    /** What `list-panes -F #{pane_dead}` answers for an existing session: one 0 / 1 line per pane. */
    readonly paneDeadFlags?: string;
    readonly created?: { readonly exitCode: number; readonly stdout: string };
    readonly launchGuard?: TmuxLaunchGuard;
    readonly session?: string;
    readonly dead?: boolean;
    readonly noPane?: boolean;
    readonly noServer?: boolean;
    readonly exitEmpty?: 'on' | 'off';
  } = {},
) {
  const sent: Array<readonly string[]> = [];
  const warned: string[] = [];
  const spawned: Array<{ readonly args: readonly string[]; readonly stdin: unknown }> = [];
  const runner = new TmuxRunner({
    tmux: {
      execute: async args => {
        sent.push(args);
        if (args[0] === 'has-session') return options.sessionExists === true ? done() : refused("can't find session");
        if (args[0] === 'list-panes') return done(options.paneDeadFlags ?? '');
        // One client starts the server and reads its options (`exit-empty` first, then `update-environment`).
        if (args[0] === 'start-server')
          return options.noServer === true
            ? refused('no server running')
            : done(`${options.exitEmpty ?? 'on'}\nPATH TERM\n`);
        if (args[0] === 'display-message')
          return options.noPane === true
            ? refused("can't find pane")
            : done(facts(options.session ?? 'fy-f-f1', options.dead ?? false));
        return done();
      },
    },
    spawn: {
      run: async (_program, args, spawnOptions) => {
        spawned.push({ args, stdin: spawnOptions?.stdin });
        const created = options.created ?? { exitCode: 0, stdout: '%9|4242\n' };
        return { exitCode: created.exitCode, signal: null, stdout: created.stdout, stderr: '' };
      },
      runBytes: () => Promise.reject(new Error('not used')),
      start: () => {
        throw new Error('not used');
      },
    },
    socketPath: '/fixture/tmux.sock',
    instantOf: () => 'then' as never,
    now: () => 'now' as never,
    ...(options.launchGuard === undefined ? {} : { launchGuard: options.launchGuard }),
    log: { warn: message => void warned.push(message) },
  });
  const spec = {
    ferret: ferretId('f1'),
    command: ['harness', '--flag'],
    cwd: fenced('/work'),
    env: emptyChildEnvironment(),
  };
  return { runner, sent, warned, spawned, spec };
}

describe('TmuxRunner launch', () => {
  it('should start a resumed conversation exactly as it starts any other', async () => {
    // Arrange
    const world = launching();

    // Act
    const resumed = await world.runner.resume(world.spec, 'conversation-1');

    // Assert
    should(resumed.ok).equal(true);
    should(world.spawned).have.length(1);
    should(String(world.spawned[0]?.stdin)).containEql('new-session');
  });

  it('should refuse a launch a guard refuses, say why once, and ask tmux nothing at all', async () => {
    // Arrange
    const guard: TmuxLaunchGuard = {
      check: async () => {
        throw new RealHarnessRefusedError('claude', '/home/u/.local/bin/claude', 'the Claude Code native install');
      },
    };
    const world = launching({ launchGuard: guard });

    // Act
    const started = await world.runner.start(world.spec);

    // Assert
    should(started.ok).equal(false);
    should(started.ok ? undefined : started.error).equal('real_harness');
    should(world.warned).have.length(1);
    should(world.sent).deepEqual([]);
    should(world.spawned).deepEqual([]);
  });

  it('should refuse a launch for an unnamed refusal too, but still reject when the guard itself failed', async () => {
    // Arrange
    const broken: TmuxLaunchGuard = {
      check: async () => {
        throw new Error('the locator failed');
      },
    };
    const world = launching({ launchGuard: broken });

    // Act
    const started = await world.runner.start(world.spec).catch((error: unknown) => error);

    // Assert
    should(started).be.instanceOf(Error);
    should((started as Error).message).equal('the locator failed');
    should(world.sent).deepEqual([]);
  });

  it('should refuse to start a ferret whose session already exists', async () => {
    // Arrange
    const world = launching({ sessionExists: true });

    // Act
    const started = await world.runner.start(world.spec);

    // Assert
    should(started.ok ? undefined : started.error).equal('failed');
    should(world.spawned).deepEqual([]);
  });

  it('should clear the dead session a polite stop left behind and start the resumed ferret in a fresh one', async () => {
    // Arrange: the pane died (remain-on-exit keeps it) but the session name is still taken
    const world = launching({ sessionExists: true, paneDeadFlags: '1\n' });

    // Act
    const resumed = await world.runner.resume(world.spec, 'conversation-1');

    // Assert
    should(resumed.ok).equal(true);
    const killed = world.sent.findIndex(args => args[0] === 'kill-session');
    should(killed).be.greaterThan(-1);
    should(world.sent[killed]).deepEqual(['kill-session', '-t', '=fy-f1']);
    should(world.spawned).have.length(1);
    should(String(world.spawned[0]?.stdin)).containEql('new-session');
  });

  it('should still refuse a session whose pane is alive, and a session whose panes cannot be read', async () => {
    // Arrange
    const alive = launching({ sessionExists: true, paneDeadFlags: '0\n' });
    const mixed = launching({ sessionExists: true, paneDeadFlags: '1\n0\n' });

    // Act
    const startedAlive = await alive.runner.start(alive.spec);
    const startedMixed = await mixed.runner.start(mixed.spec);

    // Assert: a live ferret is never killed to make room
    should(startedAlive.ok ? undefined : startedAlive.error).equal('failed');
    should(startedMixed.ok ? undefined : startedMixed.error).equal('failed');
    should(alive.sent.some(args => args[0] === 'kill-session')).equal(false);
    should(mixed.sent.some(args => args[0] === 'kill-session')).equal(false);
    should(alive.spawned).deepEqual([]);
  });

  it('should name the session by its exact name in every command, so a longer session sharing the prefix is never touched', async () => {
    // Arrange: tmux treats a bare name as a prefix match; the exact form is `=name`
    const world = launching({ sessionExists: true, paneDeadFlags: '1\n' });

    // Act
    await world.runner.start(world.spec);

    // Assert
    const targets = world.sent
      .filter(args => ['has-session', 'list-panes', 'kill-session'].includes(args[0] ?? ''))
      .map(args => [args[0], args[args.indexOf('-t') + 1]]);
    should(targets).deepEqual([
      ['has-session', '=fy-f1'],
      ['list-panes', '=fy-f1'],
      ['kill-session', '=fy-f1'],
    ]);
  });

  it('should read the panes of EVERY window and keep a session whose other window still lives', async () => {
    // Arrange: `list-panes -s` answers one line per pane of the whole session; the second window's pane is alive
    const world = launching({ sessionExists: true, paneDeadFlags: '1\n0\n' });

    // Act
    const started = await world.runner.start(world.spec);

    // Assert
    const listed = world.sent.find(args => args[0] === 'list-panes');
    should(listed?.slice(0, 2)).deepEqual(['list-panes', '-s']);
    should(started.ok ? undefined : started.error).equal('failed');
    should(world.sent.some(args => args[0] === 'kill-session')).equal(false);
  });

  it('should put the server option back from a client holding no values when the new session was not made', async () => {
    // Arrange
    const world = launching({ created: { exitCode: 1, stdout: '' } });

    // Act
    const started = await world.runner.start(world.spec);

    // Assert
    should(started.ok ? undefined : started.error).equal('failed');
    const last = world.sent.at(-1);
    should(last).deepEqual([
      'set-option',
      '-g',
      'update-environment',
      'PATH TERM',
      ';',
      'set-option',
      '-s',
      'exit-empty',
      'on',
    ]);
  });

  it('should start the server and read its options in ONE tmux client, and keep the server alive until the session exists', async () => {
    // A server with no session exits at once, so a bare `start-server` is gone before the next command asks it anything.
    // Arrange
    const world = launching();

    // Act
    const started = await world.runner.start(world.spec);

    // Assert
    should(started.ok).equal(true);
    should(world.sent.some(args => args[0] === 'show-options')).equal(false);
    const boot = world.sent.find(args => args[0] === 'start-server');
    should(boot).deepEqual([
      'start-server',
      ';',
      'show-options',
      '-sv',
      'exit-empty',
      ';',
      'set-option',
      '-s',
      'exit-empty',
      'off',
      ';',
      'show-options',
      '-gv',
      'update-environment',
    ]);
    const script = String(world.spawned[0]?.stdin);
    should(script.indexOf('new-session')).be.above(-1);
    should(script.indexOf("'exit-empty' 'on'")).be.above(script.indexOf('new-session'));
  });

  it('should put exit-empty back to a value the server already had off, not to the default', async () => {
    // Arrange
    const world = launching({ exitEmpty: 'off' });

    // Act
    await world.runner.start(world.spec);

    // Assert
    should(String(world.spawned[0]?.stdin)).containEql("'set-option' '-s' 'exit-empty' 'off'");
  });

  it('should refuse as unavailable only when tmux itself cannot start a server', async () => {
    // Arrange
    const world = launching({ noServer: true });

    // Act
    const started = await world.runner.start(world.spec);

    // Assert
    should(started.ok ? undefined : started.error).equal('unavailable');
    should(world.spawned).deepEqual([]);
  });

  it('should refuse a command that is empty or names an environment variable that is not one', async () => {
    // Arrange
    const world = launching();

    // Act
    const empty = await world.runner.start({ ...world.spec, command: [] });
    const odd = await world.runner.start({
      ...world.spec,
      env: { ...world.spec.env, names: ['NOT A NAME'] } as never,
    });

    // Assert
    should(empty.ok ? undefined : empty.error).equal('failed');
    should(odd.ok ? undefined : odd.error).equal('failed');
    should(world.spawned).deepEqual([]);
  });
});

describe('TmuxRunner signal', () => {
  const handle = '%9' as RunnerHandle;

  it('should send the interrupt key to a live ferret pane', async () => {
    // Arrange
    const world = launching();

    // Act
    await world.runner.signal(handle, 'interrupt');

    // Assert
    should(world.sent.at(-1)).deepEqual(['send-keys', '-t', '%9', 'C-c']);
  });

  it('should end a live ferret’s session on terminate', async () => {
    // Arrange
    const world = launching();

    // Act
    await world.runner.signal(handle, 'terminate');

    // Assert
    should(world.sent.at(-1)?.[0]).equal('kill-session');
  });

  it('should leave a person’s own terminal, a dead pane, a gone pane and a malformed handle alone', async () => {
    // Arrange
    const person = launching({ session: 'fy-webterm-person' });
    const dead = launching({ dead: true });
    const gone = launching({ noPane: true });
    const malformed = launching();

    // Act
    await person.runner.signal(handle, 'terminate');
    await dead.runner.signal(handle, 'interrupt');
    await gone.runner.signal(handle, 'terminate');
    await malformed.runner.signal('not-a-pane' as RunnerHandle, 'terminate');

    // Assert
    for (const world of [person, dead, gone, malformed])
      should(world.sent.filter(call => call[0] === 'kill-session' || call[0] === 'send-keys')).deepEqual([]);
    should(malformed.sent).deepEqual([]);
  });
});

describe('TmuxRunner delivery', () => {
  it('should pass on a plain tmux failure that happened before anything was typed', async () => {
    // Arrange
    const world = subject();
    world.beforeGuard(() => {
      throw new Error('tmux went away');
    });

    // Act
    const actual = await world.runner.deliver(world.handle, { text: 'hello' }).catch((error: unknown) => error);

    // Assert
    should(actual).be.instanceOf(Error);
    should(world.server.submitted).deepEqual([]);
  });
});

describe('TmuxRunner start directory', () => {
  it('should escape every # of the cwd in the new-session -c it writes to the launch script', async () => {
    // Arrange: tmux expands formats in `-c`, so a folder named like a command must reach it doubled.
    const world = launching();
    const hostile = { ...world.spec, cwd: fenced('/r/#(touch pwned)/#{session_name}') };

    // Act
    const started = await world.runner.start(hostile);

    // Assert
    should(started.ok).equal(true);
    const words = scriptWords(String(world.spawned[0]?.stdin));
    const at = words.indexOf('new-session');
    should(at).be.aboveOrEqual(0);
    should(words[words.indexOf('-c', at) + 1]).equal('/r/##(touch pwned)/##{session_name}');
    should(words).not.containEql('/r/#(touch pwned)/#{session_name}');
  });
});
