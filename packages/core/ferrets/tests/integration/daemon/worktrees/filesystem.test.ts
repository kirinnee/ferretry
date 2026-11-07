import { afterAll, describe, it } from 'bun:test';
import { lstat, symlink } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { NodeWorktreeFileSystem, SystemWorktreeClock } from '../../../src/adapters/worktrees/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

describe('NodeWorktreeFileSystem', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  it('should create a directory tree with the requested permissions', async () => {
    // Arrange
    const root = await tempDirectory('fs-mkdir');
    const target = path.join(root, 'nested', 'managed');
    const subject = new NodeWorktreeFileSystem();

    // Act
    await subject.makeDirectory(target, 0o700);

    // Assert
    should((await lstat(target)).mode & 0o777).equal(0o700);
    should(await subject.type(target)).equal('directory');
  });

  it('should accept an existing directory without failing', async () => {
    // Arrange
    const root = await tempDirectory('fs-mkdir-again');
    const subject = new NodeWorktreeFileSystem();
    await subject.makeDirectory(root, 0o700);

    // Act
    await subject.makeDirectory(root, 0o700);

    // Assert
    should(await subject.type(root)).equal('directory');
  });

  it('should classify every path kind a managed root could contain', async () => {
    // Arrange
    const root = await tempDirectory('fs-types');
    const subject = new NodeWorktreeFileSystem();
    await Bun.write(path.join(root, 'plain'), 'x');
    await symlink(path.join(root, 'plain'), path.join(root, 'link'));

    // Act + Assert — a device node stands in for anything that is neither file, dir, nor link.
    should(await subject.type(root)).equal('directory');
    should(await subject.type(path.join(root, 'plain'))).equal('file');
    should(await subject.type(path.join(root, 'link'))).equal('symlink');
    should(await subject.type('/dev/null')).equal('other');
    should(await subject.type(path.join(root, 'absent'))).equal('missing');
  });

  it('should report a symlink as a symlink rather than following it', async () => {
    // Arrange — a swapped-in symlink is exactly how a managed path gets hijacked.
    const root = await tempDirectory('fs-symlink');
    const outside = await tempDirectory('fs-outside');
    const link = path.join(root, 'managed');
    const subject = new NodeWorktreeFileSystem();
    await symlink(outside, link);

    // Act
    const kind = await subject.type(link);
    const resolved = await subject.realPath(link);

    // Assert
    should(kind).equal('symlink');
    should(resolved).equal(outside);
  });

  it('should propagate a filesystem failure that is not a missing path', async () => {
    // Arrange — a path *under* a plain file cannot be stat-ed at all (ENOTDIR).
    const root = await tempDirectory('fs-error');
    const subject = new NodeWorktreeFileSystem();
    await Bun.write(path.join(root, 'plain'), 'x');

    // Act
    const actual = await subject
      .type(path.join(root, 'plain', 'child'))
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should((actual as NodeJS.ErrnoException | undefined)?.code).equal('ENOTDIR');
  });

  it('should write a private file exactly once and read it back', async () => {
    // Arrange
    const root = await tempDirectory('fs-write');
    const target = path.join(root, 'worktree-owner');
    const subject = new NodeWorktreeFileSystem();

    // Act
    await subject.writeText(target, 'token-value', 0o600);
    const readBack = await subject.readText(target);
    const second = await subject
      .writeText(target, 'other', 0o600)
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert — refusing to overwrite is what makes the ownership marker meaningful.
    should(readBack).equal('token-value');
    should((await lstat(target)).mode & 0o777).equal(0o600);
    should((second as NodeJS.ErrnoException | undefined)?.code).equal('EEXIST');
  });

  it('should fail when a path to resolve does not exist', async () => {
    // Arrange
    const root = await tempDirectory('fs-realpath');
    const subject = new NodeWorktreeFileSystem();

    // Act
    const actual = await subject
      .realPath(path.join(root, 'absent'))
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should((actual as NodeJS.ErrnoException | undefined)?.code).equal('ENOENT');
  });

  it('should fail when text is read from a path that is not there', async () => {
    // Arrange
    const root = await tempDirectory('fs-read');
    const subject = new NodeWorktreeFileSystem();

    // Act
    const actual = await subject
      .readText(path.join(root, 'absent'))
      .then(() => undefined)
      .catch((error: unknown) => error);

    // Assert
    should((actual as NodeJS.ErrnoException | undefined)?.code).equal('ENOENT');
  });
});

describe('SystemWorktreeClock', () => {
  it('should report the current instant as a UTC ISO-8601 timestamp', () => {
    // Arrange
    const subject = new SystemWorktreeClock();

    // Act
    const actual = subject.nowIso();

    // Assert
    should(actual).match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    should(Number.isNaN(Date.parse(actual))).be.false();
  });
});
