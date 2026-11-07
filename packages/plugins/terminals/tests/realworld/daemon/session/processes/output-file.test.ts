// Realworld: asserts wall-clock speed; the outcome depends on the machine, not the code.
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { RegularOutputFile } from '../../../../src/adapters/session/processes/index.ts';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fy-output-file-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('RegularOutputFile', () => {
  it.skipIf(process.platform !== 'linux')(
    'should refuse a FIFO at the path without blocking on it (needs mkfifo and a POSIX host)',
    async () => {
      // Arrange — a FIFO with no writer: opening it for reading would hang until one appeared.
      const path = join(directory, 'pipe.log');
      const made = Bun.spawn(['mkfifo', path], { stdout: 'ignore', stderr: 'ignore' });
      should(await made.exited).equal(0);
      const started = performance.now();

      // Act
      const read = await new RegularOutputFile().read(path, undefined, 1_024);

      // Assert
      should(read.kind).equal('refused');
      should(performance.now() - started).be.below(2_000);
    },
    10_000,
  );
});
