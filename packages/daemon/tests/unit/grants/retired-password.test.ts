import { describe, it } from 'bun:test';
import should from 'should';
import { retireOperatorPassword } from '../../../src/lib/grants/index.ts';
import type { FileInformation } from '../../../src/lib/ports.ts';

const VERIFIER = '/state/fy/config/operator-password.json';

/** A tiny in-memory tree that records what was asked of it. */
function files(present: readonly string[]) {
  const held = new Set(present);
  const removed: string[] = [];
  const information = async (path: string): Promise<FileInformation | undefined> =>
    held.has(path) ? { device: '1', inode: '2', size: 64, modifiedAtMs: 0, mode: 0o600 } : undefined;
  const removeFile = async (path: string): Promise<void> => {
    removed.push(path);
    held.delete(path);
  };
  return { port: { information, removeFile }, removed, held };
}

describe('retireOperatorPassword', () => {
  it('should delete a verifier an older daemon left behind and report that it did', async () => {
    // Arrange
    const world = files([VERIFIER]);

    // Act
    const retired = await retireOperatorPassword(VERIFIER, world.port);

    // Assert
    should(retired).be.true();
    should(world.removed).deepEqual([VERIFIER]);
    should(world.held.has(VERIFIER)).be.false();
  });

  it('should report nothing and delete nothing when there was no file, so the notice is only ever true', async () => {
    // Arrange
    const world = files([]);

    // Act
    const retired = await retireOperatorPassword(VERIFIER, world.port);

    // Assert
    should(retired).be.false();
    should(world.removed).be.empty();
  });

  it('should say it once across two boots: true while the file was there, false after', async () => {
    // Arrange
    const world = files([VERIFIER]);

    // Act
    const first = await retireOperatorPassword(VERIFIER, world.port);
    const second = await retireOperatorPassword(VERIFIER, world.port);

    // Assert
    should([first, second]).deepEqual([true, false]);
    should(world.removed).deepEqual([VERIFIER]);
  });

  it('should not swallow a removal that fails, so a file it cannot delete is never reported retired', async () => {
    // Arrange
    const failure = new Error('read-only file system');
    const port = {
      information: async () => ({ device: '1', inode: '2', size: 64, modifiedAtMs: 0, mode: 0o600 }),
      removeFile: async () => {
        throw failure;
      },
    };

    // Act
    const attempt = retireOperatorPassword(VERIFIER, port);

    // Assert
    await should(attempt).be.rejectedWith(failure);
  });
});
