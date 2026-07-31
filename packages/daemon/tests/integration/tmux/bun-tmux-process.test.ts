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
      const actual = await subject.execute(['display-message', '-p', '#{pane_id}']);

      // Assert
      should(actual).deepEqual({ code: 7, stdout: 'out', stderr: 'err' });
      should((await readFile(record, 'utf8')).trimEnd().split('\n')).deepEqual([
        '-S',
        join(root, 'isolated.sock'),
        'display-message',
        '-p',
        '#{pane_id}',
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
});
