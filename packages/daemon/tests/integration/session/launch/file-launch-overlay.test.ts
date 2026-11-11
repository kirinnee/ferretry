/**
 * The per-launch Claude settings files.
 *
 * The claims: a file is written private (0600, in a 0700 directory) and whole; writing the same launch twice is
 * idempotent; asking where a file would be creates nothing; and the sweep removes only old files of its own shape,
 * never the one just placed, never a stranger's.
 */
import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, it } from 'bun:test';
import should from 'should';
import { FileLaunchOverlayFiles } from '../../../../src/adapters/session/launch/file-launch-overlay.ts';
import { cleanupTempDirectories, tempDirectory } from '../../support/repository.ts';

afterAll(cleanupTempDirectories);

const DAY = 24 * 60 * 60 * 1000;
const NAME = `launch-${'a'.repeat(24)}-f1.json`;
const OLD = `launch-${'b'.repeat(24)}.json`;

const directoryOf = async (): Promise<string> => join(await tempDirectory('launch-overlay'), 'launch-settings');

describe('FileLaunchOverlayFiles', () => {
  it('should write the file private and whole, in a private directory, and return its path', async () => {
    // Arrange
    const directory = await directoryOf();

    // Act
    const path = await new FileLaunchOverlayFiles(directory).place(
      { name: NAME, content: '{"fastMode":true}' },
      { write: true },
    );

    // Assert
    should(path).equal(join(directory, NAME));
    should(await readFile(path as string, 'utf8')).equal('{"fastMode":true}');
    should((await stat(path as string)).mode & 0o777).equal(0o600);
    should((await stat(directory)).mode & 0o777).equal(0o700);
    should(await readdir(directory)).eql([NAME]);
  });

  it('should replace a file whose content differs, atomically, and leave no temporary behind', async () => {
    // Arrange
    const directory = await directoryOf();
    const files = new FileLaunchOverlayFiles(directory);
    await files.place({ name: NAME, content: 'one' }, { write: true });

    // Act
    await files.place({ name: NAME, content: 'two' }, { write: true });
    await files.place({ name: NAME, content: 'two' }, { write: true });

    // Assert
    should(await readFile(join(directory, NAME), 'utf8')).equal('two');
    should(await readdir(directory)).eql([NAME]);
  });

  it('should create nothing when only asked where a file would be', async () => {
    // Arrange
    const directory = await directoryOf();

    // Act
    const path = await new FileLaunchOverlayFiles(directory).place({ name: NAME, content: 'x' }, { write: false });

    // Assert
    should(path).equal(join(directory, NAME));
    await should(stat(directory)).rejected();
  });

  it('should sweep an old file of its own shape and keep recent ones, the one just placed and strangers', async () => {
    // Arrange
    const directory = await directoryOf();
    await mkdir(directory, { recursive: true });
    const stranger = join(directory, 'notes.txt');
    const recent = join(directory, `launch-${'c'.repeat(24)}.json`);
    const leftover = join(directory, `.launch-${'d'.repeat(24)}.json.1.abc.tmp`);
    for (const path of [join(directory, OLD), stranger, recent, leftover]) await writeFile(path, 'x');
    const longAgo = new Date(Date.now() - 40 * DAY);
    for (const path of [join(directory, OLD), stranger, leftover]) await utimes(path, longAgo, longAgo);

    // Act
    await new FileLaunchOverlayFiles(directory).place({ name: NAME, content: 'now' }, { write: true });

    // Assert
    should((await readdir(directory)).sort()).eql([NAME, 'notes.txt', `launch-${'c'.repeat(24)}.json`].sort());
  });

  it('should keep a file alive that is looked at, however old it was', async () => {
    // Arrange
    const directory = await directoryOf();
    const files = new FileLaunchOverlayFiles(directory);
    await files.place({ name: NAME, content: 'x' }, { write: true });
    const longAgo = new Date(Date.now() - 40 * DAY);
    await utimes(join(directory, NAME), longAgo, longAgo);

    // Act: a stale-settings read, then another launch's write sweeps.
    await files.place({ name: NAME, content: 'x' }, { write: false });
    await files.place({ name: OLD, content: 'y' }, { write: true });

    // Assert
    should((await readdir(directory)).sort()).eql([NAME, OLD].sort());
  });
});
