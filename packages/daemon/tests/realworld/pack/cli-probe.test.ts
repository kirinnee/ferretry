// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { bunProbeSpawn } from '../../../src/adapters/pack/cli-probe.ts';

describe('bunProbeSpawn', () => {
  it('should time out and kill a CLI that sleeps past the deadline', async () => {
    // Arrange
    const dir = await mkdtemp(join(tmpdir(), 'ferretry-pack-probe-'));
    const path = join(dir, 'cli.sh');
    await writeFile(path, '#!/bin/sh\nsleep 30\n');
    await chmod(path, 0o755);
    try {
      const started = performance.now();

      // Act
      const outcome = await bunProbeSpawn({
        cmd: [path],
        cwd: dir,
        env: { PATH: process.env.PATH ?? '' },
        timeoutMs: 150,
      });

      // Assert — it returned at the deadline, not after the sleep.
      should(outcome).eql({ kind: 'timeout' });
      should(performance.now() - started).be.below(5_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
