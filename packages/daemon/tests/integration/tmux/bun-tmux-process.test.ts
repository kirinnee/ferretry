import { describe, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import should from 'should';
import { BunTmuxProcess } from '../../../src/adapters/index.ts';

describe('BunTmuxProcess', () => {
  it('should invoke only its injected tmux executable with its mandatory isolated socket', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'ferretry-tmux-adapter-'));
    const executable = join(root, 'fake-tmux.sh');
    const record = join(root, 'arguments.txt');
    await writeFile(
      executable,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\nprintf 'out'\nprintf 'err' >&2\nexit 7\n`,
    );
    await chmod(executable, 0o700);
    const subject = new BunTmuxProcess(executable, join(root, 'isolated.sock'));

    try {
      // Act
      const actual = await subject.execute(['capture-pane', '-p', '-S', '-', '-t', 'work']);

      // Assert
      should(actual).deepEqual({ code: 7, stdout: 'out', stderr: 'err' });
      should((await readFile(record, 'utf8')).trimEnd().split('\n')).deepEqual([
        '-u',
        '-S',
        join(root, 'isolated.sock'),
        'capture-pane',
        '-p',
        '-S',
        '-',
        '-t',
        'work',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should refuse a non-absolute executable or socket path before spawning', () => {
    // Act + Assert
    should(() => new BunTmuxProcess('tmux', '/tmp/socket')).throw(Error);
    should(() => new BunTmuxProcess('/usr/bin/tmux', 'socket')).throw(Error);
  });

  it('should refuse empty argv and a leading socket override without spawning', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'ferretry-tmux-adapter-'));
    const executable = join(root, 'fake-tmux.sh');
    const record = join(root, 'arguments.txt');
    await writeFile(executable, `#!/bin/sh\nprintf invoked > '${record}'\n`);
    await chmod(executable, 0o700);
    const subject = new BunTmuxProcess(executable, join(root, 'isolated.sock'));

    try {
      // Act + Assert
      await should(subject.execute([])).be.rejectedWith(Error);
      await should(subject.execute(['-S', '/tmp/evil.sock', 'kill-session', '-t', 'work'])).be.rejectedWith(Error);
      await should(readFile(record, 'utf8')).be.rejectedWith(Error);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should get tabs and unicode back from a real tmux even when this process has no UTF-8 locale', async () => {
    // Every tab-separated format the daemon sends — the terminal listing, the pane identity a launch
    // must prove — depends on this. A tmux client whose locale is not UTF-8 prints each tab and
    // non-ASCII byte as `_`, and a daemon started by `fy daemon start` or a service manager has no
    // locale unless it is handed one. `-u` is what makes the answer independent of that; dropping it
    // fails here by name instead of as an empty terminal list or a session that never starts.
    // Arrange
    const tmux = Bun.which('tmux');
    if (tmux === null) throw new Error('tmux is required for this test and was not found');
    const root = await mkdtemp(join(tmpdir(), 'fy-tmux-u-'));
    // The locale is forced by a wrapper rather than by editing this process's environment: a spawn
    // does not see a change made to `process.env` after startup, so that version passed without `-u`.
    const executable = join(root, 'c-locale-tmux.sh');
    await writeFile(executable, `#!/bin/sh\nexec env -i PATH=/usr/bin:/bin LC_ALL=C '${tmux}' "$@"\n`);
    await chmod(executable, 0o700);
    const subject = new BunTmuxProcess(executable, join(root, 's'));

    try {
      const created = await subject.execute(['new-session', '-d', '-s', 'work', 'sleep', '30']);
      should(created.code).equal(0, created.stderr);
      await subject.execute(['set-option', '-t', 'work', '@fy_probe', 'héllo']);

      // Act
      const actual = await subject.execute(['list-sessions', '-F', '#{session_name}\t#{@fy_probe}']);

      // Assert
      should(actual.stdout).equal('work\théllo\n');
    } finally {
      await subject.execute(['kill-server']);
      await rm(root, { recursive: true, force: true });
    }
  });
});
