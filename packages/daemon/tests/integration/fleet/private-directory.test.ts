/**
 * The private working folder a runtime check starts its CLI in, against a REAL file system in a temporary
 * folder: created `0700`, tightened when loose, and refused when it is a symlink, a file, or another
 * account's.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { ensureOwnedPrivateDirectory, PrivateDirectoryError } from '../../../src/adapters/fleet/private-directory.ts';

const folders: string[] = [];

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function sandbox(): Promise<string> {
  const folder = await realpath(await mkdtemp(path.join(tmpdir(), 'fy-private-dir-')));
  folders.push(folder);
  return folder;
}

const modeOf = async (target: string): Promise<number> => (await lstat(target)).mode & 0o777;

describe('ensureOwnedPrivateDirectory', () => {
  it('should create a missing folder (and its parents) readable by its owner alone', async () => {
    // Arrange
    const target = path.join(await sandbox(), 'tmp', 'runtime-check');

    // Act
    const actual = await ensureOwnedPrivateDirectory(target, { uid: process.getuid?.() });

    // Assert
    should(actual).equal(target);
    should(await modeOf(target)).equal(0o700);
  });

  it('should keep an existing folder of ours, and take group and other permissions away from it', async () => {
    // Arrange
    const target = path.join(await sandbox(), 'runtime-check');
    await mkdir(target);
    await chmod(target, 0o777);

    // Act
    await ensureOwnedPrivateDirectory(target, { uid: process.getuid?.() });

    // Assert
    should(await modeOf(target)).equal(0o700);
  });

  it('should not check ownership when the platform has no uid to compare', async () => {
    // Arrange
    const target = path.join(await sandbox(), 'runtime-check');

    // Act + Assert
    should(await ensureOwnedPrivateDirectory(target)).equal(target);
  });

  it('should refuse a symbolic link, even one that points at a folder of ours', async () => {
    // Arrange — somebody swapped the folder for a link into a place they control
    const root = await sandbox();
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    const target = path.join(root, 'runtime-check');
    await symlink(elsewhere, target);

    // Act
    const refusal = await ensureOwnedPrivateDirectory(target, { uid: process.getuid?.() }).catch(
      (error: unknown) => error,
    );

    // Assert
    should(refusal).be.instanceOf(PrivateDirectoryError);
    should((refusal as Error).message).containEql('symbolic link');
  });

  it('should refuse a path that is a file', async () => {
    // Arrange — a plain file where the folder should be: mkdir cannot make a folder there, and the answer is a plain error
    const root = await sandbox();
    const target = path.join(root, 'runtime-check');
    await writeFile(target, '');

    // Act
    const refusal = await ensureOwnedPrivateDirectory(target).catch((error: unknown) => error);

    // Assert — mkdir itself refuses on some platforms; either way nothing is handed out
    should(refusal).be.instanceOf(Error);
  });

  it('should refuse a folder another account owns', async () => {
    // Arrange — claim to be a different account than the folder's owner
    const target = path.join(await sandbox(), 'runtime-check');
    await mkdir(target);
    const owner = (await lstat(target)).uid;

    // Act
    const refusal = await ensureOwnedPrivateDirectory(target, { uid: owner + 1 }).catch((error: unknown) => error);

    // Assert
    should(refusal).be.instanceOf(PrivateDirectoryError);
    should((refusal as Error).message).containEql('another account');
  });
});
