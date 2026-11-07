import { afterAll, describe, it } from 'bun:test';
import path from 'node:path';
import should from 'should';
import { BunGitRunner, GitProcessError } from '../../../src/adapters/git/index.ts';
import { cleanupTempDirectories, tempRepository } from '../support/repository.ts';

describe('BunGitRunner working-directory validation', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  it('fails before spawning Git when the requested working directory is a file', async () => {
    // Arrange
    const repository = await tempRepository('runner-file-cwd');
    const subject = new BunGitRunner();

    // Act
    const actual = await subject
      .run({ cwd: path.join(repository.root, 'README.md'), args: ['status'] })
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should(actual).be.instanceof(GitProcessError);
    should((actual as GitProcessError).code).equal('spawn_failed');
    should((actual as GitProcessError).cause).not.be.undefined();
  });
});
