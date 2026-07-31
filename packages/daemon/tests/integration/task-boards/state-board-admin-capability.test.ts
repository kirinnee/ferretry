import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, it } from 'bun:test';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { StateBoardAdminCapability } from '../../../src/adapters/task-boards/state-board-admin-capability.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/** Every case allocates a throwaway state home; nothing resolves the developer's real `~/.ferretry`. */
async function capability(mint: () => string = () => 'minted-capability') {
  const home = await tempDirectory('board-admin-capability');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  await files.ensureDirectory(paths.home, 0o700);
  return {
    paths,
    files,
    subject: new StateBoardAdminCapability(paths, files, mint),
    /** A second reader over the SAME home, so nothing is served from the first one's memory. */
    reopen: (nextMint: () => string) => new StateBoardAdminCapability(paths, files, nextMint),
  };
}

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('StateBoardAdminCapability', () => {
  it('should mint the operator capability into the state home on first use', async () => {
    // Arrange
    const { paths, subject } = await capability();

    // Act
    const hash = await subject.hash();

    // Assert
    should(hash).equal(createHash('sha256').update('minted-capability', 'utf8').digest('hex'));
    should((await readFile(join(paths.home, 'board-admin-capability'), 'utf8')).trim()).equal('minted-capability');
  });

  it('should report the file the operator reads it from', async () => {
    // Arrange
    const { paths, subject } = await capability();

    // Act & Assert
    should(subject.file()).equal(join(paths.home, 'board-admin-capability'));
  });

  it('should write it owner-only, because a readable file is board authority given away', async () => {
    // Arrange
    const { subject } = await capability();

    // Act
    await subject.hash();

    // Assert
    should((await stat(subject.file())).mode & 0o777).equal(0o600);
  });

  it('should mint exactly once and serve the same answer thereafter', async () => {
    // Arrange
    let minted = 0;
    const { subject } = await capability(() => {
      minted += 1;
      return `capability-${minted}`;
    });

    // Act
    const first = await subject.hash();
    const second = await subject.hash();

    // Assert
    should(minted).equal(1);
    should(second).equal(first);
  });

  it('should reuse a capability an earlier boot persisted', async () => {
    // Arrange
    const { paths, files, subject } = await capability();
    await files.writeTextAtomic(join(paths.home, 'board-admin-capability'), 'from-an-earlier-boot\n');

    // Act
    const hash = await subject.hash();

    // Assert
    should(hash).equal(createHash('sha256').update('from-an-earlier-boot', 'utf8').digest('hex'));
    should(subject).be.ok();
  });

  it('should treat an emptied file as absent rather than locking the operator out with no cause', async () => {
    // Arrange
    const { subject, reopen } = await capability();
    await subject.hash();
    await writeFile(subject.file(), '   \n', 'utf8');

    // Act
    const replacement = reopen(() => 'freshly-minted');

    // Assert
    should(await replacement.hash()).equal(createHash('sha256').update('freshly-minted', 'utf8').digest('hex'));
  });

  it('should mint an unguessable capability by default, so a real boot never gets a fixed one', async () => {
    // Arrange
    const home = await tempDirectory('board-admin-capability-default');
    const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
    const files = new StateFileSystem(paths);
    await files.ensureDirectory(paths.home, 0o700);

    // Act
    await new StateBoardAdminCapability(paths, files).hash();

    // Assert
    should((await readFile(join(paths.home, 'board-admin-capability'), 'utf8')).trim()).match(/^[A-Za-z0-9_-]{43}$/u);
  });
});
