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
import { bunShellSpawn, LoginShellEnvironment } from '../../../src/adapters/fleet/login-shell-environment.ts';

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

function reader(shell: string, folder: string, timeoutMs = 5_000): LoginShellEnvironment {
  return new LoginShellEnvironment({
    shell: { shell: async () => shell },
    spawn: bunShellSpawn,
    env: { HOME: folder, PATH: '/usr/bin:/bin' },
    cwd: folder,
    timeoutMs,
  });
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
    const actual = await reader(shell, folder, 300).read(() => true);

    // Assert
    should(actual).deepEqual({ state: 'unavailable', cause: 'timed-out' });
  });

  it('should answer failed for a shell that exits without running the command', async () => {
    // Arrange
    const { shell, folder } = await fakeShell(`echo 'csh: -i: unknown option'; exit 1`);

    // Act + Assert
    should(await reader(shell, folder).read(() => true)).deepEqual({ state: 'unavailable', cause: 'failed' });
  });
});
