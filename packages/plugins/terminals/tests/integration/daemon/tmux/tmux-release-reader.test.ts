import { describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { TmuxReleaseReader } from '../../../src/adapters/tmux/tmux-release-reader.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../../src/lib/tmux/contracts.ts';

/** A server that answers `answer`, recording what it was asked. Never a real tmux server. */
const server = (answer: () => Promise<TmuxCommandResult>): TmuxCommandPort & { readonly asked: string[][] } => {
  const asked: string[][] = [];
  return {
    asked,
    execute: async arguments_ => {
      asked.push([...arguments_]);
      return await answer();
    },
  };
};

const noServer = server(async () => ({ code: 1, stdout: '', stderr: 'no server running on /x/tmux.sock\n' }));

/** A stand-in tmux program: a shell script that does `body`. */
async function program(body: string): Promise<{ readonly path: string; readonly dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-tmux-release-'));
  const path = join(root, 'tmux');
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return { path, dispose: async () => await rm(root, { recursive: true, force: true }) };
}

describe('TmuxReleaseReader', () => {
  it("should read the installed program and this daemon's own server", async () => {
    // Arrange
    const tmux = await program('[ "$1" = "-V" ] && echo "tmux 3.6a"');
    const port = server(async () => ({ code: 0, stdout: '3.6a\n', stderr: '' }));

    try {
      // Act
      const actual = await new TmuxReleaseReader(tmux.path, port).read();

      // Assert
      should(actual).deepEqual({ program: 'tmux 3.6a', server: '3.6a' });
      should(port.asked).deepEqual([['display-message', '-p', '#{version}']]);
    } finally {
      await tmux.dispose();
    }
  });

  it('should read the real tmux on this host the way the doctor will', async () => {
    // Arrange — only `-V`: it prints and exits, and no server is asked or started.
    const executable = Bun.which('tmux');
    if (executable === null) throw new Error('the integration tier runs with tmux installed');

    // Act
    const actual = await new TmuxReleaseReader(executable, noServer).read();

    // Assert
    should(actual.program).match(/^tmux \S+$/u);
    should(actual.server).be.undefined();
  });

  it('should answer nothing for a program that cannot run, fails, or prints nothing', async () => {
    // Arrange
    const failing = await program('exit 3');
    const silent = await program('exit 0');

    try {
      // Act
      const actual = await Promise.all([
        new TmuxReleaseReader(join(tmpdir(), 'no-such-dir', 'tmux'), noServer).read(),
        new TmuxReleaseReader(failing.path, noServer).read(),
        new TmuxReleaseReader(silent.path, noServer).read(),
      ]);

      // Assert — every failure is an absent answer, never a guess.
      should(actual).deepEqual([{}, {}, {}]);
    } finally {
      await Promise.all([failing.dispose(), silent.dispose()]);
    }
  });

  it('should give up on a program and a server that do not answer in time', async () => {
    // Arrange
    const hung = await program('exec sleep 30');
    const silentServer = server(async () => await new Promise<TmuxCommandResult>(() => undefined));

    try {
      // Act
      const actual = await new TmuxReleaseReader(hung.path, silentServer, 50).read();

      // Assert — it settled at all: a wedged tmux cannot hold a doctor report.
      should(actual).deepEqual({});
    } finally {
      await hung.dispose();
    }
  });

  it('should answer no server for an empty answer or a port that throws', async () => {
    // Arrange
    const tmux = await program('echo "tmux 3.8"');
    const empty = server(async () => ({ code: 0, stdout: '\n', stderr: '' }));
    const throwing = server(async () => {
      throw new Error('spawn failed');
    });

    try {
      // Act
      const actual = await Promise.all([
        new TmuxReleaseReader(tmux.path, empty).read(),
        new TmuxReleaseReader(tmux.path, throwing).read(),
      ]);

      // Assert
      should(actual).deepEqual([{ program: 'tmux 3.8' }, { program: 'tmux 3.8' }]);
    } finally {
      await tmux.dispose();
    }
  });
});
