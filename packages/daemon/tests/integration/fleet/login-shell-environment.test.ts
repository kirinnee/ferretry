/**
 * The login-shell reader against a REAL process: a fake "shell" written to a temporary folder, never the
 * owner's own shell or home. It proves what the unit tier cannot — the argv a real program receives, that
 * stdin is empty and stderr is never read, and that a real process is killed at the deadline.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import {
  bunShellSpawn,
  LoginShellEnvironment,
  loginShellBaseEnvironment,
  type ShellProcess,
  type ShellSpawn,
} from '../../../src/adapters/fleet/login-shell-environment.ts';

const folders: string[] = [];

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

/** A fake shell: the script body runs whatever argv it is given, as `/bin/sh` would see it. */
async function fakeShell(body: string): Promise<{ shell: string; folder: string }> {
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), 'fy-login-shell-')));
  folders.push(folder);
  const shell = path.join(folder, 'fake-shell');
  await writeFile(shell, `#!/bin/sh\n${body}\n`);
  await chmod(shell, 0o755);
  return { shell, folder };
}

function reader(
  shell: string,
  folder: string,
  limits: { readonly timeoutMs?: number; readonly maxBytes?: number; readonly drainMs?: number } = {},
  spawn: ShellSpawn = bunShellSpawn,
): LoginShellEnvironment {
  return new LoginShellEnvironment({
    shell: { shell: async () => shell },
    spawn,
    env: { HOME: folder, PATH: '/usr/bin:/bin' },
    cwd: folder,
    timeoutMs: limits.timeoutMs ?? 5_000,
    ...(limits.maxBytes === undefined ? {} : { maxBytes: limits.maxBytes }),
    ...(limits.drainMs === undefined ? {} : { drainMs: limits.drainMs }),
  });
}

/** A "process" whose pieces the test scripts: a fake spawn for the failures a real shell cannot be made to show. */
function scripted(parts: {
  readonly stdout?: ReadableStream<Uint8Array>;
  readonly exited?: Promise<number>;
  readonly kill?: () => void;
}): ShellSpawn {
  return () =>
    ({
      stdout: parts.stdout ?? new ReadableStream<Uint8Array>(),
      exited: parts.exited ?? new Promise<number>(() => undefined),
      kill: parts.kill ?? (() => undefined),
    }) satisfies ShellProcess;
}

/** Whether a process is still running (a killed child nobody has reaped yet is a zombie, not running). */
async function running(pid: number): Promise<boolean> {
  const state = await Bun.$`ps -o stat= -p ${pid}`.nothrow().text();
  return state.trim() !== '' && !state.trim().startsWith('Z');
}

describe('LoginShellEnvironment over a real process', () => {
  it('should hand the shell the fixed argv and read what it prints after the marker', async () => {
    // Arrange — the fake shell records its argv and stdin, banners on both streams, then runs the command
    const { shell, folder } = await fakeShell(
      [
        `printf '%s\\n' "$@" > "$HOME/argv"`,
        `cat > "$HOME/stdin"`,
        `echo 'Welcome!'`,
        `echo 'nvm: noisy' >&2`,
        `export AWS_PROFILE=work CLAUDE_CODE_USE_BEDROCK=1 GITHUB_TOKEN=ghp_dropped`,
        `shift 3`,
        `exec /bin/sh -c "$1"`,
      ].join('\n'),
    );

    // Act
    const actual = await reader(shell, folder).read(
      name => name === 'AWS_PROFILE' || name === 'CLAUDE_CODE_USE_BEDROCK',
    );

    // Assert
    should(actual).deepEqual({ state: 'read', env: { AWS_PROFILE: 'work', CLAUDE_CODE_USE_BEDROCK: '1' } });
    should(await Bun.file(path.join(folder, 'argv')).text()).equal(
      ['-l', '-i', '-c', 'printf "\\0FY-ENV\\0"; command env -0', ''].join('\n'),
    );
    should(await Bun.file(path.join(folder, 'stdin')).text()).equal('');
  });

  it('should kill a shell that never answers, and say it timed out', async () => {
    // Arrange
    const { shell, folder } = await fakeShell('exec sleep 30');

    // Act
    const actual = await reader(shell, folder, { timeoutMs: 300 }).read(() => true);

    // Assert
    should(actual).deepEqual({ state: 'unavailable', cause: 'timed-out' });
  });

  it('should answer failed for a shell that exits without running the command', async () => {
    // Arrange
    const { shell, folder } = await fakeShell(`echo 'csh: -i: unknown option'; exit 1`);

    // Act + Assert
    should(await reader(shell, folder).read(() => true)).deepEqual({ state: 'unavailable', cause: 'failed' });
  });

  it('should kill the whole group, so a program an rc file backgrounded does not outlive the read', async () => {
    // Arrange — the rc file backgrounds a long sleep (holding the pipe open) and records its pid, then the command runs
    const { shell, folder } = await fakeShell(
      [`sleep 30 &`, `echo $! > "$HOME/background.pid"`, `shift 3`, `exec /bin/sh -c "$1"`].join('\n'),
    );

    // Act — the shell exits at once; the sleeper holds the pipe, so the read ends on the drain window
    const actual = await reader(shell, folder, { drainMs: 100 }).read(() => true);
    const pid = Number((await Bun.file(path.join(folder, 'background.pid')).text()).trim());

    // Assert — the answer was read, and the background program is gone with the shell's group
    should(actual.state).equal('read');
    should(Number.isInteger(pid) && pid > 0).be.true();
    let alive = await running(pid);
    for (let waited = 0; alive && waited < 2_000; waited += 50) {
      await Bun.sleep(50);
      alive = await running(pid);
    }
    should(alive).be.false();
  });

  it('should not throw when asked to kill a shell whose group is already gone', async () => {
    // Arrange — a shell that has exited and been reaped: its group no longer exists
    const { shell, folder } = await fakeShell('exit 0');
    const child = bunShellSpawn({ argv: [shell], env: { PATH: '/usr/bin:/bin' }, cwd: folder });
    await child.exited;
    await Bun.sleep(50);

    // Act + Assert — the group kill finds nothing and falls back to the shell itself, quietly
    should(() => child.kill('SIGKILL')).not.throw();
  });

  it('should answer failed when the shell prints more than it may', async () => {
    // Arrange — far past a 256-byte cap
    const { shell, folder } = await fakeShell(`exec /usr/bin/head -c 100000 /dev/zero`);

    // Act + Assert
    should(await reader(shell, folder, { maxBytes: 256 }).read(() => true)).deepEqual({
      state: 'unavailable',
      cause: 'failed',
    });
  });

  it('should answer failed, not throw, when no shell can be resolved', async () => {
    // Arrange
    const missing = new LoginShellEnvironment({
      shell: {
        shell: async () => {
          throw new Error('no shell');
        },
      },
      spawn: bunShellSpawn,
      env: {},
      cwd: tmpdir(),
    });

    // Act + Assert
    should(await missing.read(() => true)).deepEqual({ state: 'unavailable', cause: 'failed' });
  });

  it('should answer failed, not throw, when the shell cannot be started', async () => {
    // Arrange
    const spawn: ShellSpawn = () => {
      throw new Error('ENOENT');
    };

    // Act + Assert
    should(await reader('/nonexistent/shell', tmpdir(), {}, spawn).read(() => true)).deepEqual({
      state: 'unavailable',
      cause: 'failed',
    });
  });

  it('should answer failed when the process ends in error before it printed anything, and when kill refuses', async () => {
    // Arrange — `exited` rejects and `kill` throws: neither may escape
    const spawn = scripted({
      exited: Promise.reject(new Error('wait failed')),
      kill: () => {
        throw new Error('ESRCH');
      },
    });

    // Act + Assert
    should(await reader('/bin/sh', tmpdir(), {}, spawn).read(() => true)).deepEqual({
      state: 'unavailable',
      cause: 'failed',
    });
  });

  it('should answer failed when reading the output errors', async () => {
    // Arrange — the pipe breaks on its first read
    const stdout = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('broken pipe'));
      },
    });

    // Act + Assert
    should(await reader('/bin/sh', tmpdir(), {}, scripted({ stdout })).read(() => true)).deepEqual({
      state: 'unavailable',
      cause: 'failed',
    });
  });
});

describe('loginShellBaseEnvironment', () => {
  it('should keep only the few variables a login shell needs, pin HOME to the account, and default PATH', () => {
    // Act
    const actual = loginShellBaseEnvironment(
      { HOME: '/daemon-home', USER: 'kirin', LANG: 'en_GB.UTF-8', EMPTY: '', LC_ALL: '', GITHUB_TOKEN: 'ghp_not_kept' },
      '/home/kirin',
    );

    // Assert
    should(actual).deepEqual({
      HOME: '/home/kirin',
      USER: 'kirin',
      LANG: 'en_GB.UTF-8',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    });
  });

  it("should keep the daemon's own PATH when it has one", () => {
    // Act + Assert
    should(loginShellBaseEnvironment({ PATH: '/opt/bin:/usr/bin' }, '/home/kirin')).deepEqual({
      HOME: '/home/kirin',
      PATH: '/opt/bin:/usr/bin',
    });
  });
});
