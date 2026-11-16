import { describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bunSpawn } from '@ferretry/kernel/host';
import should from 'should';
import {
  releaseReader,
  tmuxReleaseDoctor,
  tmuxReleaseFinding,
  tmuxReleaseSelftest,
  tmuxSocketIn,
} from '../../../../daemon/adapters/tmux/tmux-release-checks.ts';
import { realAfter } from '../support/host-spawn.ts';

/**
 * A directory holding a stand-in `tmux` program: a shell script, never a real tmux and never a server. It answers
 * `-V` with `program` and a `display-message` with `server` (exit 1 when `server` is empty, as a socket nobody serves).
 */
async function fakeTmux(program: string, server: string) {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-tmux-checks-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  const script = [
    '#!/bin/sh',
    `if [ "$1" = "-V" ]; then echo '${program}'; exit 0; fi`,
    ...(server === ''
      ? ['echo "no server running on $3" >&2', 'exit 1']
      : [`for arg in "$@"; do if [ "$arg" = "display-message" ]; then echo '${server}'; exit 0; fi; done`, 'exit 1']),
  ].join('\n');
  await writeFile(join(bin, 'tmux'), `${script}\n`);
  await chmod(join(bin, 'tmux'), 0o755);
  return { root, bin, dispose: async () => await rm(root, { recursive: true, force: true }) };
}

const clock = { after: realAfter, nowMs: () => Date.now() } as unknown as Parameters<
  typeof tmuxReleaseSelftest.run
>[0]['clock'];

const environmentFor = (bin: string, stateDir: string | undefined) => ({
  stateDir,
  spawn: bunSpawn({ PATH: `${bin}:/usr/bin:/bin` }),
  tempDir: '/unused',
  signal: new AbortController().signal,
  clock: clock as never,
});

describe('tmuxSocketIn', () => {
  it('should name the socket in the state folder however many slashes it ends in', () => {
    // Act
    const plain = tmuxSocketIn('/home/fy/state/terminals');
    const slashed = tmuxSocketIn('/home/fy/state/terminals///');

    // Assert
    should(plain).equal('/home/fy/state/terminals/tmux.sock');
    should(slashed).equal(plain);
  });
});

describe('tmuxReleaseFinding', () => {
  it('should be ok for a present release and a warning, never a failure, for a missing one', () => {
    // Act
    const present = tmuxReleaseFinding({ status: 'present', summary: 'installed 3.7', impact: 'nothing to do' });
    const missing = tmuxReleaseFinding({ status: 'missing', summary: 'installed 3.6a', impact: 'upgrade tmux' });

    // Assert
    should(present).deepEqual({ state: 'ok', detail: 'installed 3.7', fix: 'nothing to do' });
    should(missing).deepEqual({ state: 'warn', detail: 'installed 3.6a', fix: 'upgrade tmux' });
  });
});

describe('tmuxReleaseDoctor', () => {
  it('should report the finding for what tmux said and nothing when tmux could not be asked', async () => {
    // Arrange
    const heard = tmuxReleaseDoctor(async () => ({ program: 'tmux 3.7', server: '3.7' }));
    const silent = tmuxReleaseDoctor(async () => ({}));

    // Act
    const found = await heard();
    const none = await silent();

    // Assert
    should(found?.state).equal('ok');
    should(none).be.undefined();
  });
});

describe('releaseReader', () => {
  it('should ask the installed program and this daemon’s own socket, each bounded', async () => {
    // Arrange
    const tmux = await fakeTmux('tmux 3.6a', '3.6a');

    try {
      // Act
      const actual = await releaseReader(
        bunSpawn({ PATH: `${tmux.bin}:/usr/bin:/bin` }),
        '/unused/tmux.sock',
        realAfter,
        5000,
      ).read();

      // Assert
      should(actual).deepEqual({ program: 'tmux 3.6a', server: '3.6a' });
    } finally {
      await tmux.dispose();
    }
  });
});

describe('tmuxReleaseSelftest', () => {
  it('should name both releases when the daemon’s own server answers', async () => {
    // Arrange
    const tmux = await fakeTmux('tmux 3.7', '3.7');

    try {
      // Act
      const actual = await tmuxReleaseSelftest.run(environmentFor(tmux.bin, '/home/fy/state/terminals'));

      // Assert
      should(actual).containEql('3.7');
    } finally {
      await tmux.dispose();
    }
  });

  it('should fail the line, starting no server, when none is running on the daemon socket', async () => {
    // Arrange
    const tmux = await fakeTmux('tmux 3.7', '');

    try {
      // Act
      const actual = await tmuxReleaseSelftest
        .run(environmentFor(tmux.bin, '/home/fy/state/terminals'))
        .catch((error: unknown) => error);

      // Assert
      should(actual).be.instanceOf(Error);
      should((actual as Error).message).match(/no tmux server is running/);
    } finally {
      await tmux.dispose();
    }
  });

  it('should fail the line when tmux names no release it understands', async () => {
    // Arrange
    const tmux = await fakeTmux('not a release', 'not a release either');

    try {
      // Act
      const actual = await tmuxReleaseSelftest
        .run(environmentFor(tmux.bin, '/home/fy/state/terminals'))
        .catch((error: unknown) => error);

      // Assert
      should(actual).be.instanceOf(Error);
      should((actual as Error).message).match(/did not name its release/);
    } finally {
      await tmux.dispose();
    }
  });

  it('should refuse to run without the spawn port and state folder the check hands it', async () => {
    // Act
    const noSpawn = await tmuxReleaseSelftest
      .run({ ...environmentFor('/nowhere', '/state'), spawn: undefined })
      .catch((error: unknown) => error);
    const noState = await tmuxReleaseSelftest
      .run(environmentFor('/nowhere', undefined))
      .catch((error: unknown) => error);

    // Assert
    should(noSpawn).be.instanceOf(Error);
    should(noState).be.instanceOf(Error);
  });
});
