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
});
