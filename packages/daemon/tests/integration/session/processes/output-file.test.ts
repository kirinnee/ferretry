import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { RegularOutputFile } from '../../../../src/adapters/session/processes/index.ts';

/**
 * THE OUTPUT-FILE READER, over real files, FIFOs and symlinks.
 *
 * What it must never do is OPEN something another reader owns: a FIFO at the path would block this
 * daemon on open and then be drained, so every case here that names one must come back at once.
 */

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fy-output-file-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('RegularOutputFile', () => {
  it('should read the tail of a file larger than the window, saying where the window starts', async () => {
    // Arrange
    const path = join(directory, 'out.log');
    await writeFile(path, '0123456789');

    // Act
    const read = await new RegularOutputFile().read(path, undefined, 4);

    // Assert
    should(read.kind).equal('read');
    if (read.kind !== 'read') return;
    should(text(read.bytes)).equal('6789');
    should([read.start, read.size]).deepEqual([6, 10]);
  });

  it('should read everything written after the offset a follower holds', async () => {
    // Arrange
    const path = join(directory, 'out.log');
    await writeFile(path, 'hello world\n');

    // Act
    const read = await new RegularOutputFile().read(path, 6, 1_024);

    // Assert
    should(read.kind).equal('read');
    if (read.kind !== 'read') return;
    should(text(read.bytes)).equal('world\n');
    should([read.start, read.size]).deepEqual([6, 12]);
  });

  it('should skip the gap and start at the tail when the follower fell further behind than one read', async () => {
    // Arrange
    const path = join(directory, 'out.log');
    await writeFile(path, 'abcdefghij');

    // Act
    const read = await new RegularOutputFile().read(path, 1, 3);

    // Assert
    should(read.kind).equal('read');
    if (read.kind !== 'read') return;
    should(text(read.bytes)).equal('hij');
    should(read.start).equal(7);
  });

  it('should start again from the tail when the file shrank below the offset', async () => {
    // Arrange
    const path = join(directory, 'out.log');
    await writeFile(path, 'a long line of output\n');
    await truncate(path, 5);

    // Act
    const read = await new RegularOutputFile().read(path, 20, 1_024);

    // Assert
    should(read.kind).equal('read');
    if (read.kind !== 'read') return;
    should(text(read.bytes)).equal('a lon');
    should([read.start, read.size]).deepEqual([0, 5]);
  });

  it('should answer an empty read, not a refusal, when nothing was written since the offset', async () => {
    // Arrange
    const path = join(directory, 'out.log');
    await writeFile(path, 'done\n');

    // Act
    const read = await new RegularOutputFile().read(path, 5, 1_024);

    // Assert
    should(read.kind).equal('read');
    if (read.kind !== 'read') return;
    should(read.bytes.byteLength).equal(0);
    should([read.start, read.size]).deepEqual([5, 5]);
  });

  it('should report size only for a zero-byte probe, as the ended-row check does', async () => {
    // Arrange
    const path = join(directory, 'out.log');
    await writeFile(path, 'abc');

    // Act
    const read = await new RegularOutputFile().read(path, 0, 0);

    // Assert
    should(read).deepEqual({ kind: 'read', bytes: new Uint8Array(0), start: 3, size: 3 });
  });

  it('should answer gone for a path that does not exist', async () => {
    // Act
    const read = await new RegularOutputFile().read(join(directory, 'missing.log'), undefined, 1_024);

    // Assert
    should(read).deepEqual({ kind: 'gone' });
  });

  it('should refuse a relative path, never resolving it against the daemon’s directory', async () => {
    // Act
    const read = await new RegularOutputFile().read('tasks/1.output', undefined, 1_024);

    // Assert
    should(read.kind).equal('refused');
  });

  it('should refuse a directory', async () => {
    // Arrange
    const path = join(directory, 'folder');
    await mkdir(path);

    // Act
    const read = await new RegularOutputFile().read(path, undefined, 1_024);

    // Assert
    should(read.kind).equal('refused');
  });

  it('should refuse a symlink, even one that points at a regular file', async () => {
    // Arrange
    const target = join(directory, 'real.log');
    const link = join(directory, 'link.log');
    await writeFile(target, 'secret');
    await symlink(target, link);

    // Act
    const read = await new RegularOutputFile().read(link, undefined, 1_024);

    // Assert
    should(read.kind).equal('refused');
  });

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
