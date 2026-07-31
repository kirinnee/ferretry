import { describe, it } from 'bun:test';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { AtomicFileWriter } from '../../../src/adapters/tasks/atomic-file.ts';
import { NodeTaskFileOperations } from '../../../src/adapters/tasks/file-operations.ts';
import type { TaskFileOperations } from '../../../src/adapters/tasks/file-operations.ts';
import { FixedTempNameSource, shouldReject, withTempRoot } from './fixtures.ts';

/** Wraps the real filesystem and fails exactly one named step, leaving every other step honest. */
class FaultyFileOperations implements TaskFileOperations {
  readonly calls: string[] = [];
  private readonly inner = new NodeTaskFileOperations();
  private readonly failOn: 'write' | 'replace' | null;

  constructor(failOn: 'write' | 'replace' | null) {
    this.failOn = failOn;
  }

  async read(path: string): Promise<string | null> {
    return await this.inner.read(path);
  }

  async ensureDirectory(path: string, mode: number): Promise<void> {
    await this.inner.ensureDirectory(path, mode);
  }

  async write(path: string, contents: string, mode: number): Promise<void> {
    this.calls.push('write');
    if (this.failOn === 'write') throw new Error('disk full');
    await this.inner.write(path, contents, mode);
  }

  async replace(from: string, to: string): Promise<void> {
    this.calls.push('replace');
    if (this.failOn === 'replace') throw new Error('rename failed');
    await this.inner.replace(from, to);
  }

  async discard(path: string): Promise<void> {
    this.calls.push('discard');
    await this.inner.discard(path);
  }
}

describe('AtomicFileWriter', () => {
  it('should create the containing directory and round-trip the payload', async () => {
    await withTempRoot(async root => {
      // Arrange
      const subject = new AtomicFileWriter();
      const target = join(root, 'board', 'tasks.json');

      // Act
      await subject.write(target, '{"v":1}\n');
      const actual = await subject.read(target);

      // Assert
      should(actual).equal('{"v":1}\n');
      should(await subject.read(join(root, 'board', 'absent.json'))).be.null();
    });
  });

  it('should leave no scratch file behind on a successful write', async () => {
    await withTempRoot(async root => {
      // Arrange
      const subject = new AtomicFileWriter();
      const target = join(root, 'tasks.json');

      // Act
      await subject.write(target, 'first');
      await subject.write(target, 'second');

      // Assert
      should(await subject.read(target)).equal('second');
      should(await readdir(root)).deepEqual(['tasks.json']);
    });
  });

  it('should set private file and directory modes so the board is not world-readable', async () => {
    await withTempRoot(async root => {
      // Arrange
      const subject = new AtomicFileWriter();
      const target = join(root, 'nested', 'tasks.json');

      // Act
      await subject.write(target, 'private');

      // Assert
      should((await stat(target)).mode & 0o777).equal(0o600);
      should((await stat(join(root, 'nested'))).mode & 0o777).equal(0o700);
    });
  });

  it('should keep the previous contents and clean the scratch file when the write step fails', async () => {
    await withTempRoot(async root => {
      // Arrange
      const target = join(root, 'tasks.json');
      await new AtomicFileWriter().write(target, 'original');
      const files = new FaultyFileOperations('write');
      const subject = new AtomicFileWriter(files, new FixedTempNameSource(['scratch1']));

      // Act
      const act = async (): Promise<void> => await subject.write(target, 'replacement');

      // Assert
      await should(act()).be.rejectedWith('disk full');
      should(await new AtomicFileWriter().read(target)).equal('original');
      should(await readdir(root)).deepEqual(['tasks.json']);
      should(files.calls).deepEqual(['write', 'discard']);
    });
  });

  it('should keep the previous contents and clean the scratch file when the rename step fails', async () => {
    await withTempRoot(async root => {
      // Arrange
      const target = join(root, 'tasks.json');
      await new AtomicFileWriter().write(target, 'original');
      const files = new FaultyFileOperations('replace');
      const subject = new AtomicFileWriter(files, new FixedTempNameSource(['scratch1']));

      // Act
      const act = async (): Promise<void> => await subject.write(target, 'replacement');

      // Assert
      await should(act()).be.rejectedWith('rename failed');
      should(await new AtomicFileWriter().read(target)).equal('original');
      should(await readdir(root)).deepEqual(['tasks.json']);
      should(files.calls).deepEqual(['write', 'replace', 'discard']);
    });
  });

  it('should never expose a partially written document to a concurrent reader', async () => {
    await withTempRoot(async root => {
      // Arrange
      const target = join(root, 'tasks.json');
      const subject = new AtomicFileWriter();
      const payloads = Array.from({ length: 25 }, (_index, index) => `${'x'.repeat(4096)}:${index}`);
      await subject.write(target, payloads[0] as string);

      // Act
      const reads: (string | null)[] = [];
      await Promise.all([
        (async () => {
          for (const payload of payloads) await subject.write(target, payload);
        })(),
        (async () => {
          for (let index = 0; index < 60; index += 1) reads.push(await subject.read(target));
        })(),
      ]);

      // Assert — every observed value is a complete payload, never a truncated one.
      should(reads.every(value => value !== null && payloads.includes(value))).be.true();
    });
  });

  it('should place the scratch file beside its target so the rename stays on one filesystem', () => {
    // Arrange
    const subject = new AtomicFileWriter(new NodeTaskFileOperations(), new FixedTempNameSource(['abc123']));

    // Act
    const actual = subject.scratchFor('/var/lib/fy/board/tasks.json');

    // Assert
    should(actual).equal('/var/lib/fy/board/.tasks.json.abc123.tmp');
  });

  it('should refuse a temp-name collaborator that returns an unsafe token', () => {
    // Arrange
    const subject = new AtomicFileWriter(new NodeTaskFileOperations(), new FixedTempNameSource(['../escape']));

    // Act + Assert
    should(() => subject.scratchFor('/var/lib/fy/tasks.json')).throw(/unsafe scratch token/u);
  });

  it.each([[''], ['relative/tasks.json'], ['./tasks.json']])(
    'should refuse the non-absolute snapshot path %j',
    async path => {
      // Arrange
      const subject = new AtomicFileWriter();

      // Act + Assert
      await shouldReject('invalid', async () => await subject.write(path, 'nope'));
      await shouldReject('invalid', async () => await subject.read(path));
    },
  );

  it('should surface a genuine read fault instead of reporting an absent file', async () => {
    await withTempRoot(async root => {
      // Arrange — a directory where a file is expected is an IO fault, not "no board yet".
      const target = join(root, 'tasks.json');
      await new NodeTaskFileOperations().ensureDirectory(target, 0o700);
      await writeFile(join(target, 'decoy'), 'x');
      const subject = new AtomicFileWriter();

      // Act
      const act = async (): Promise<string | null> => await subject.read(target);

      // Assert
      await should(act()).be.rejected();
    });
  });
});
