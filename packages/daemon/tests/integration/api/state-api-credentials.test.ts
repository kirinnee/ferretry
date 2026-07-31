import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, it } from 'bun:test';
import should from 'should';
import { mintToken, StateApiCredentials } from '../../../src/adapters/api/index.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * Every case here allocates a throwaway state home under the OS temp directory. Nothing resolves
 * the developer's real `~/.ferretry`.
 */
async function credentials(mint: () => string = () => 'minted-token') {
  const home = await tempDirectory('api-credentials');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  await files.ensureDirectory(paths.home, 0o700);
  return { paths, files, subject: new StateApiCredentials(paths, files, mint) };
}

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('mintToken', () => {
  it('should produce a distinct, URL-safe secret each time', () => {
    // Arrange / Act
    const tokens = Array.from({ length: 32 }, () => mintToken());

    // Assert
    should(new Set(tokens).size).equal(tokens.length);
    for (const token of tokens) should(token).match(/^[A-Za-z0-9_-]{43}$/);
  });

  it('should be the default minter, so a real boot never gets a guessable token', async () => {
    // Arrange
    const home = await tempDirectory('api-credentials-default');
    const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
    const files = new StateFileSystem(paths);
    await files.ensureDirectory(paths.home, 0o700);

    // Act
    const loaded = await new StateApiCredentials(paths, files).load();

    // Assert
    should(loaded.admin).match(/^[A-Za-z0-9_-]{43}$/);
    should(loaded.warden).not.equal(loaded.admin);
  });
});

describe('StateApiCredentials', () => {
  it('should mint both tokens on a first boot', async () => {
    // Arrange
    const issued = { count: 0 };
    const { subject } = await credentials(() => {
      issued.count += 1;
      return `token-${issued.count}`;
    });

    // Act
    const loaded = await subject.load();

    // Assert
    should(loaded.admin).equal('token-1');
    should(loaded.warden).equal('token-2');
  });

  it('should persist what it minted so a restart keeps the same tokens', async () => {
    // Arrange
    const issued = { count: 0 };
    const { paths, files } = await credentials();
    const first = new StateApiCredentials(paths, files, () => {
      issued.count += 1;
      return `token-${issued.count}`;
    });
    const second = new StateApiCredentials(paths, files, () => 'a-different-token');

    // Act
    const before = await first.load();
    const after = await second.load();

    // Assert
    should(after).deepEqual(before);
  });

  it('should write the token files owner-readable only', async () => {
    // A token another local account can read is the whole authorization model gone.
    // Arrange
    const { paths, subject } = await credentials();

    // Act
    await subject.load();
    const mode = (await stat(join(paths.home, 'api-token'))).mode & 0o777;

    // Assert
    should(mode).equal(0o600);
  });

  it('should tolerate the trailing newline it writes', async () => {
    // Arrange
    const { paths, files, subject } = await credentials();
    await files.writeTextAtomic(join(paths.home, 'api-token'), 'stored-admin\n');
    await files.writeTextAtomic(join(paths.home, 'api-warden-token'), '  stored-warden  \n');

    // Act
    const loaded = await subject.load();

    // Assert
    should(loaded).deepEqual({ admin: 'stored-admin', warden: 'stored-warden' });
  });

  it('should replace an emptied token file rather than locking the operator out', async () => {
    // An empty secret authenticates nothing, so leaving one in place would refuse every request
    // with no diagnosable cause.
    // Arrange
    const { paths, files, subject } = await credentials();
    await files.writeTextAtomic(join(paths.home, 'api-token'), '   \n');

    // Act
    const loaded = await subject.load();

    // Assert
    should(loaded.admin).equal('minted-token');
    should((await files.readText(join(paths.home, 'api-token')))?.trim()).equal('minted-token');
  });
});
