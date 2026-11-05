/**
 * Reading the owner's login shell for the setup scan: what is parsed out of what the shell printed
 * (`lib/fleet/shell-environment.ts`), and the process around it with the shell faked
 * (`adapters/fleet/login-shell-environment.ts`) — no real shell, no real home.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  LoginShellEnvironment,
  loginShellBaseEnvironment,
  type ShellProcess,
  type ShellSpawn,
} from '../../../src/adapters/fleet/login-shell-environment.ts';
import {
  parseShellEnvironment,
  SHELL_ENVIRONMENT_COMMAND,
  SHELL_ENVIRONMENT_MARKER,
  shellEnvironmentArgv,
} from '../../../src/lib/fleet/shell-environment.ts';

const KEEP_ALL = (): boolean => true;
const entries = (...pairs: string[]): string => pairs.map(pair => `${pair}\u0000`).join('');

describe('parseShellEnvironment', () => {
  it('should read only what follows the marker, ignoring an rc file’s banner', () => {
    // Arrange
    const output = `Welcome back!\nnvm: using node 22\n${SHELL_ENVIRONMENT_MARKER}${entries('AWS_PROFILE=work', 'AWS_REGION=us-east-1')}`;

    // Act + Assert
    should(parseShellEnvironment(output, KEEP_ALL)).deepEqual({ AWS_PROFILE: 'work', AWS_REGION: 'us-east-1' });
  });

  it('should keep a value that spans lines or holds an equals sign whole', () => {
    // Arrange
    const output = `${SHELL_ENVIRONMENT_MARKER}${entries('NOTE=line one\nline two', 'URL=https://x.example/?a=b')}`;

    // Act + Assert
    should(parseShellEnvironment(output, KEEP_ALL)).deepEqual({
      NOTE: 'line one\nline two',
      URL: 'https://x.example/?a=b',
    });
  });

  it('should answer undefined when the shell never reached the command', () => {
    should(parseShellEnvironment('zsh: command not found: printf\n', KEEP_ALL)).be.undefined();
    should(parseShellEnvironment('', KEEP_ALL)).be.undefined();
  });

  it('should read after the LAST marker, so an rc file that printed one cannot inject entries', () => {
    // Arrange
    const output = `${SHELL_ENVIRONMENT_MARKER}${entries('CLAUDE_CODE_USE_BEDROCK=1')}${SHELL_ENVIRONMENT_MARKER}${entries('AWS_REGION=eu-west-1')}`;

    // Act + Assert
    should(parseShellEnvironment(output, KEEP_ALL)).deepEqual({ AWS_REGION: 'eu-west-1' });
  });

  it('should drop an unterminated tail, garbage entries and names that are not variable names', () => {
    // Arrange — a logout file printing after env, an entry with no "=", one starting with "=", a bad name
    const output = `${SHELL_ENVIRONMENT_MARKER}${entries('GOOD=1', 'no-equals', '=empty-name', 'BAD-NAME=x', '1LEAD=x')}TRAILING=never`;

    // Act + Assert
    should(parseShellEnvironment(output, KEEP_ALL)).deepEqual({ GOOD: '1' });
  });

  it('should let a later entry of the same name win, as an environment does', () => {
    should(parseShellEnvironment(`${SHELL_ENVIRONMENT_MARKER}${entries('A=1', 'A=2')}`, KEEP_ALL)).deepEqual({
      A: '2',
    });
  });

  it('should keep only the names it is told to, and never hold the rest', () => {
    // Arrange
    const asked: string[] = [];
    const keep = (name: string): boolean => {
      asked.push(name);
      return name === 'AWS_PROFILE';
    };
    const output = `${SHELL_ENVIRONMENT_MARKER}${entries('GITHUB_TOKEN=ghp_secretvalue123456', 'AWS_PROFILE=work')}`;

    // Act
    const actual = parseShellEnvironment(output, keep);

    // Assert
    should(actual).deepEqual({ AWS_PROFILE: 'work' });
    should(JSON.stringify(actual)).not.containEql('ghp_secretvalue');
    should(asked).deepEqual(['GITHUB_TOKEN', 'AWS_PROFILE']);
  });
});

describe('shellEnvironmentArgv', () => {
  it('should be the fixed login, interactive command with nothing of anybody’s in it', () => {
    should(shellEnvironmentArgv('/bin/zsh')).deepEqual(['/bin/zsh', '-l', '-i', '-c', SHELL_ENVIRONMENT_COMMAND]);
    should(SHELL_ENVIRONMENT_COMMAND).equal('printf "\\0FY-ENV\\0"; command env -0');
  });
});

/** A started shell that prints `output` and exits, or never does. */
function shellProcess(
  output: string | undefined,
  options: { holdPipe?: boolean; exitCode?: number } = {},
): {
  process: ShellProcess;
  killed: string[];
} {
  const killed: string[] = [];
  let close: (() => void) | undefined;
  let exit: ((code: number) => void) | undefined;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      if (output !== undefined) controller.enqueue(new TextEncoder().encode(output));
      close = () => {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      if (output !== undefined && options.holdPipe !== true) controller.close();
    },
  });
  const exited = new Promise<number>(resolve => {
    exit = resolve;
    if (output !== undefined) resolve(options.exitCode ?? 0);
  });
  return {
    process: {
      stdout,
      exited,
      kill: signal => {
        killed.push(signal);
        close?.();
        exit?.(137);
      },
    },
    killed,
  };
}

function reader(spawn: ShellSpawn, overrides: { shell?: () => Promise<string> } = {}): LoginShellEnvironment {
  return new LoginShellEnvironment({
    shell: { shell: overrides.shell ?? (async () => '/bin/zsh') },
    spawn,
    env: { HOME: '/home/owner', TERM: 'xterm-256color', PATH: '/usr/bin' },
    cwd: '/home/owner',
  });
}

describe('LoginShellEnvironment', () => {
  it('should start the owner’s shell with the fixed argv, a dumb terminal and its own SHELL, and read it', async () => {
    // Arrange
    const started: Parameters<ShellSpawn>[0][] = [];
    const shell = reader(input => {
      started.push(input);
      return shellProcess(`hello\n${SHELL_ENVIRONMENT_MARKER}${entries('AWS_PROFILE=work', 'HOME=/home/owner')}`)
        .process;
    });

    // Act
    const actual = await shell.read(name => name === 'AWS_PROFILE');

    // Assert
    should(actual).deepEqual({ state: 'read', env: { AWS_PROFILE: 'work' } });
    should(started).deepEqual([
      {
        argv: ['/bin/zsh', '-l', '-i', '-c', SHELL_ENVIRONMENT_COMMAND],
        env: { HOME: '/home/owner', TERM: 'dumb', PATH: '/usr/bin', SHELL: '/bin/zsh' },
        cwd: '/home/owner',
      },
    ]);
  });

  it('should kill a shell that does not answer in 5 s and say it timed out', async () => {
    // Arrange — an rc file that never returns
    const started = shellProcess(undefined);
    const shell = reader(() => started.process);

    // Act
    const actual = await shell.read(KEEP_ALL);

    // Assert
    should(actual).deepEqual({ state: 'unavailable', cause: 'timed-out' });
    should(started.killed).deepEqual(['SIGKILL']);
  });

  it('should still read a shell that exited while something it started holds the pipe open', async () => {
    // Arrange
    const started = shellProcess(`${SHELL_ENVIRONMENT_MARKER}${entries('AWS_REGION=us-east-1')}`, { holdPipe: true });
    const shell = reader(() => started.process);

    // Act
    const actual = await shell.read(KEEP_ALL);

    // Assert
    should(actual).deepEqual({ state: 'read', env: { AWS_REGION: 'us-east-1' } });
  });

  it('should answer unavailable, never throw, when the shell cannot be started or never reaches the command', async () => {
    // Arrange
    const unstartable = reader(() => {
      throw new Error('ENOENT');
    });
    const unresolved = reader(() => shellProcess('').process, {
      shell: async () => {
        throw new Error('no shell');
      },
    });
    const noMarker = reader(() => shellProcess('csh: -i: unknown option\n', { exitCode: 1 }).process);

    // Act + Assert
    should(await unstartable.read(KEEP_ALL)).deepEqual({ state: 'unavailable', cause: 'failed' });
    should(await unresolved.read(KEEP_ALL)).deepEqual({ state: 'unavailable', cause: 'failed' });
    should(await noMarker.read(KEEP_ALL)).deepEqual({ state: 'unavailable', cause: 'failed' });
  });

  it('should stop reading output past its cap', async () => {
    // Arrange
    const shell = new LoginShellEnvironment({
      shell: { shell: async () => '/bin/sh' },
      spawn: () => shellProcess(`${SHELL_ENVIRONMENT_MARKER}${entries(`BIG=${'x'.repeat(64)}`)}`).process,
      env: {},
      cwd: '/',
      maxBytes: 16,
    });

    // Act + Assert
    should(await shell.read(KEEP_ALL)).deepEqual({ state: 'unavailable', cause: 'failed' });
  });
});

describe('loginShellBaseEnvironment', () => {
  it('should hand the shell the account’s own few variables, never what the daemon inherited', () => {
    // Act
    const actual = loginShellBaseEnvironment(
      {
        HOME: '/elsewhere',
        USER: 'owner',
        LANG: 'en_GB.UTF-8',
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_API_KEY: 'sk-ant-api03-secret',
        FY_HOME: '/state',
      },
      '/home/owner',
    );

    // Assert
    should(actual).deepEqual({
      HOME: '/home/owner',
      USER: 'owner',
      LANG: 'en_GB.UTF-8',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    });
  });
});
