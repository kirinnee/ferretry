import { afterAll, describe, it } from 'bun:test';
import { closeSync, openSync, realpathSync } from 'node:fs';
import { rmdir } from 'node:fs/promises';
import should from 'should';
import { loadDirectorySyscalls } from '../../../../src/adapters/session/filesystem/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../../support/repository.ts';

/**
 * The two kernel calls the pinner borrows, against the real kernel: change the working directory by
 * descriptor, and say where it is now — including when it is no longer anywhere.
 */

afterAll(cleanupTempDirectories);

/** Runs `body` with the process in `directory`, and always puts it back where it was. */
async function inside<T>(directory: string, body: () => Promise<T> | T): Promise<T> {
  const syscalls = loadDirectorySyscalls();
  const home = openSync(process.cwd(), 'r');
  const held = openSync(directory, 'r');
  try {
    should(syscalls.fchdir(held)).equal(0);
    return await body();
  } finally {
    syscalls.fchdir(home);
    closeSync(held);
    closeSync(home);
  }
}

describe('the kernel directory calls', () => {
  it('should report the directory a descriptor moved the process into', async () => {
    // Arrange
    const directory = await tempDirectory('fy-directory-syscalls-');
    const syscalls = loadDirectorySyscalls();

    // Act
    const reported = await inside(directory, () => syscalls.currentDirectory());

    // Assert
    should(reported).equal(realpathSync(directory));
  });

  it('should refuse to name a working directory that was removed from under the process', async () => {
    // Arrange
    const directory = await tempDirectory('fy-directory-syscalls-');
    const syscalls = loadDirectorySyscalls();

    // Act
    const failure = await inside(directory, async () => {
      await rmdir(directory);
      try {
        return syscalls.currentDirectory();
      } catch (error) {
        return error;
      }
    });

    // Assert
    should(failure).be.an.Error();
    should((failure as Error).message).equal('the kernel would not report the current directory');
  });
});
