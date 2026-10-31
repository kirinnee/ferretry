import { describe, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('should send a pane’s environment and typed keys on stdin, never as arguments', async () => {
    // Arrange — the fake records its argv and its stdin, which is everything a process listing and
    // the program itself can see.
    const root = await mkdtemp(join(tmpdir(), 'ferretry-tmux-adapter-'));
    const executable = join(root, 'fake-tmux.sh');
    const argv = join(root, 'arguments.txt');
    const input = join(root, 'stdin.txt');
    await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argv}'\ncat >> '${input}'\n`);
    await chmod(executable, 0o700);
    const subject = new BunTmuxProcess(executable, join(root, 'isolated.sock'));
    const capability = 'fy-cap-do-not-list-me';

    try {
      // Act
      await subject.execute([
        'new-session',
        '-d',
        '-s',
        'fy-a',
        '-e',
        `FY_SESSION_BOARD_CAPABILITY=${capability}`,
        'agent',
      ]);
      await subject.execute(['send-keys', '-H', '-t', '%1', '68', '75', '6e']);

      // Assert
      const listed = await readFile(argv, 'utf8');
      should(listed).not.containEql(capability);
      should(listed).not.containEql('6e');
      should(listed.trimEnd().split('\n')).deepEqual([
        '-u',
        '-S',
        join(root, 'isolated.sock'),
        'start-server',
        ';',
        'source-file',
        '-',
        '-u',
        '-S',
        join(root, 'isolated.sock'),
        'source-file',
        '-',
      ]);
      should(await readFile(input, 'utf8')).equal(
        `'new-session' '-d' '-s' 'fy-a' '-e' 'FY_SESSION_BOARD_CAPABILITY=${capability}' 'agent'\n'send-keys' '-H' '-t' '%1' '68' '75' '6e'\n`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should hand a real pane exactly the environment it was given, with no argv on the host showing it', async () => {
    // Arrange — values chosen to break any quoting that is not exact: expansion, quotes, a newline.
    const tmux = Bun.which('tmux');
    if (tmux === null) throw new Error('tmux is required for this test and was not found');
    const root = await mkdtemp(join(tmpdir(), 'fy-tmux-env-'));
    const subject = new BunTmuxProcess(tmux, join(root, 's'));
    const out = join(root, 'env.json');
    const secret = `fy-cap-${String(process.pid)} $HOME 'q' "d" #{pane_id} ;\nline2`;
    const program = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env.FY_PROBE ?? null)); setTimeout(() => {}, 30000)`;

    try {
      // Act — this launch STARTS the server, the case that used to keep the value in its argv for good.
      const created = await subject.execute([
        'new-session',
        '-d',
        '-s',
        'work',
        '-e',
        `FY_PROBE=${secret}`,
        process.execPath,
        '-e',
        program,
      ]);
      should(created.code).equal(0, created.stderr);
      for (let tries = 0; tries < 100 && !(await Bun.file(out).exists()); tries += 1) await Bun.sleep(50);
      const server = Number((await subject.execute(['display-message', '-p', '#{pid}'])).stdout.trim());

      // Assert
      should(JSON.parse(await readFile(out, 'utf8'))).equal(secret);
      should(await readFile(`/proc/${String(server)}/cmdline`, 'utf8')).not.containEql(`fy-cap-${String(process.pid)}`);
    } finally {
      await subject.execute(['kill-server']);
      await rm(root, { recursive: true, force: true });
    }
  });
});
