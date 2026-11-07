import { afterEach, describe, it } from 'bun:test';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { fsyncArtifactPath, TransferArtifactDurability } from '../../../src/adapters/transfer/durable-artifact.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The confirm step of a replay's PROVE, FLUSH, CONFIRM, on a real filesystem.
 *
 * A name that is merely gone is a lost race and answers `false`; a name that cannot be resolved for any
 * OTHER reason is not a race, and vouching for or swallowing it would let a receipt advance in front
 * of bytes nobody could confirm — so it must surface as the filesystem's own error.
 */

async function reject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('TransferArtifactDurability name confirmation', () => {
  afterEach(async () => await cleanupTempDirectories());

  it('should surface a name that cannot be resolved for a reason other than being absent', async () => {
    // Arrange: the artifact is proved, then the directory that holds its name is swapped for a file.
    const root = await tempDirectory('durable-artifact-names');
    const directory = join(root, 'artifact');
    const file = join(directory, 'original');
    await mkdir(directory);
    await writeFile(file, 'frozen bytes');
    const subject = new TransferArtifactDurability(undefined, {
      syncDirectory: async path => {
        await fsyncArtifactPath(path);
        if (path === directory) {
          await rename(directory, join(root, 'moved'));
          await writeFile(directory, 'not a directory');
        }
      },
      syncOpenFile: async handle => await handle.sync(),
    });

    // Act
    const error = await reject(
      subject.proveDurable(directory, root, [{ file, proves: bytes => bytes.toString() === 'frozen bytes' }]),
    );

    // Assert
    should((error as NodeJS.ErrnoException).code).equal('ENOTDIR');
  });

  it('should answer false, not throw, when the proved name has simply vanished before it is confirmed', async () => {
    // Arrange
    const root = await tempDirectory('durable-artifact-vanished');
    const directory = join(root, 'artifact');
    const file = join(directory, 'original');
    await mkdir(directory);
    await writeFile(file, 'frozen bytes');
    const subject = new TransferArtifactDurability(undefined, {
      syncDirectory: async path => {
        await fsyncArtifactPath(path);
        if (path === directory) await rename(file, join(root, 'moved'));
      },
      syncOpenFile: async handle => await handle.sync(),
    });

    // Act
    const durable = await subject.proveDurable(directory, root, [
      { file, proves: bytes => bytes.toString() === 'frozen bytes' },
    ]);

    // Assert: the first attempt loses the race, the second cannot even prove the artifact.
    should(durable).equal(false);
  });
});
