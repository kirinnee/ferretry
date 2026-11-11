/**
 * The per-launch Claude settings files.
 *
 * The claims: a file is written private (0600, in a 0700 directory) and whole, and a FRESH file every time, whatever
 * is found at the path (a planted symlink is replaced, its target untouched); a directory that is a symlink, or is
 * writable by others, refuses the launch; asking where a file would be creates nothing; and the sweep removes only
 * old files of its own shape, never the one just placed, never a stranger's and never one a live session's command names.
 */
import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, it } from 'bun:test';
import should from 'should';
import {
  FileLaunchOverlayFiles,
  type LiveLaunchCommands,
} from '../../../../src/adapters/session/launch/file-launch-overlay.ts';
import { cleanupTempDirectories, tempDirectory } from '../../support/repository.ts';

afterAll(cleanupTempDirectories);

const DAY = 24 * 60 * 60 * 1000;
const NAME = `launch-${'a'.repeat(24)}-f1.json`;
const OLD = `launch-${'b'.repeat(24)}.json`;

const nobody: LiveLaunchCommands = { commands: async () => [] };

/** A state home with the launch directory named inside it (not yet created). */
const homeOf = async (): Promise<{ root: string; directory: string }> => {
  const root = await tempDirectory('launch-overlay');
  return { root, directory: join(root, 'state', 'launch-settings') };
};

const filesOf = (
  home: { root: string; directory: string },
  live: LiveLaunchCommands = nobody,
): FileLaunchOverlayFiles => new FileLaunchOverlayFiles(home.directory, { root: home.root, live });

describe('FileLaunchOverlayFiles', () => {
  it('should write the file private and whole, in a private directory, and return its path', async () => {
    // Arrange
    const home = await homeOf();

    // Act
    const path = await filesOf(home).place({ name: NAME, content: '{"fastMode":true}' }, { write: true });

    // Assert
    should(path).equal(join(home.directory, NAME));
    should(await readFile(path as string, 'utf8')).equal('{"fastMode":true}');
    should((await stat(path as string)).mode & 0o777).equal(0o600);
    should((await stat(home.directory)).mode & 0o777).equal(0o700);
    should(await readdir(home.directory)).eql([NAME]);
  });

  it('should write a fresh file each launch, atomically, and leave no temporary behind', async () => {
    // Arrange
    const home = await homeOf();
    const files = filesOf(home);
    await files.place({ name: NAME, content: 'one' }, { write: true });
    const first = (await stat(join(home.directory, NAME))).ino;

    // Act: different content, then the same content again.
    await files.place({ name: NAME, content: 'two' }, { write: true });
    const second = (await stat(join(home.directory, NAME))).ino;
    await files.place({ name: NAME, content: 'two' }, { write: true });
    const third = (await stat(join(home.directory, NAME))).ino;

    // Assert: never reused, even when the content matches.
    should(await readFile(join(home.directory, NAME), 'utf8')).equal('two');
    should(second).not.equal(first);
    should(third).not.equal(second);
    should(await readdir(home.directory)).eql([NAME]);
  });

  it('should replace a planted symlink with a regular 0600 file and leave its target untouched', async () => {
    // Arrange: a symlink at the final path to a file with the SAME content, and another to a different one.
    const home = await homeOf();
    const files = filesOf(home);
    await files.place({ name: OLD, content: 'seed' }, { write: true });
    const matching = join(home.root, 'matching.json');
    const different = join(home.root, 'different.json');
    await writeFile(matching, 'wanted', { mode: 0o644 });
    await writeFile(different, 'other', { mode: 0o644 });
    await symlink(matching, join(home.directory, NAME));
    await symlink(different, join(home.directory, `launch-${'c'.repeat(24)}.json`));

    // Act
    const placed = await files.place({ name: NAME, content: 'wanted' }, { write: true });
    const other = await files.place({ name: `launch-${'c'.repeat(24)}.json`, content: 'wanted' }, { write: true });

    // Assert: regular private files now, the symlink targets as they were (content and mode).
    for (const path of [placed as string, other as string]) {
      const found = await lstat(path);
      should(found.isSymbolicLink()).be.false();
      should(found.isFile()).be.true();
      should(found.mode & 0o777).equal(0o600);
      should(await readFile(path, 'utf8')).equal('wanted');
    }
    should(await readFile(matching, 'utf8')).equal('wanted');
    should((await stat(matching)).mode & 0o777).equal(0o644);
    should(await readFile(different, 'utf8')).equal('other');
    should((await stat(different)).mode & 0o777).equal(0o644);
  });

  it('should refuse a launch directory that is a symlink', async () => {
    // Arrange: the directory is a link to somewhere else.
    const home = await homeOf();
    const elsewhere = join(home.root, 'elsewhere');
    await mkdir(elsewhere, { mode: 0o700 });
    await mkdir(join(home.root, 'state'), { mode: 0o700 });
    await symlink(elsewhere, home.directory);

    // Act / Assert
    await should(filesOf(home).place({ name: NAME, content: 'x' }, { write: true })).rejectedWith(/launch-settings/u);
    should(await readdir(elsewhere)).eql([]);
  });

  it('should refuse a state directory above it that is a symlink', async () => {
    // Arrange: `state` is a link; the launch directory inside it would be real.
    const home = await homeOf();
    const elsewhere = join(home.root, 'elsewhere');
    await mkdir(join(elsewhere, 'launch-settings'), { recursive: true, mode: 0o700 });
    await symlink(elsewhere, join(home.root, 'state'));

    // Act / Assert
    await should(filesOf(home).place({ name: NAME, content: 'x' }, { write: true })).rejectedWith(/state/u);
    should(await readdir(join(elsewhere, 'launch-settings'))).eql([]);
  });

  it('should refuse a group-writable launch directory and not repair it', async () => {
    // Arrange
    const home = await homeOf();
    await mkdir(home.directory, { recursive: true });
    await chmod(home.directory, 0o770);

    // Act / Assert: refused, and the mode is left as found (no chmod by path).
    await should(filesOf(home).place({ name: NAME, content: 'x' }, { write: true })).rejectedWith(/writable/u);
    should((await stat(home.directory)).mode & 0o777).equal(0o770);
    should(await readdir(home.directory)).eql([]);
  });

  it('should create nothing when only asked where a file would be', async () => {
    // Arrange
    const home = await homeOf();

    // Act
    const path = await filesOf(home).place({ name: NAME, content: 'x' }, { write: false });

    // Assert
    should(path).equal(join(home.directory, NAME));
    await should(stat(home.directory)).rejected();
  });

  it('should sweep an old file of its own shape and keep recent ones, the one just placed and strangers', async () => {
    // Arrange
    const home = await homeOf();
    await mkdir(home.directory, { recursive: true, mode: 0o700 });
    const stranger = join(home.directory, 'notes.txt');
    const recent = join(home.directory, `launch-${'c'.repeat(24)}.json`);
    const leftover = join(home.directory, `.launch-${'d'.repeat(24)}.json.1.abc.tmp`);
    for (const path of [join(home.directory, OLD), stranger, recent, leftover]) await writeFile(path, 'x');
    const longAgo = new Date(Date.now() - 40 * DAY);
    for (const path of [join(home.directory, OLD), stranger, leftover]) await utimes(path, longAgo, longAgo);

    // Act
    await filesOf(home).place({ name: NAME, content: 'now' }, { write: true });

    // Assert
    should((await readdir(home.directory)).sort()).eql([NAME, 'notes.txt', `launch-${'c'.repeat(24)}.json`].sort());
  });

  it('should keep a 31-day-old file a live session’s command names, and sweep it once no live session does', async () => {
    // Arrange
    const home = await homeOf();
    await mkdir(home.directory, { recursive: true, mode: 0o700 });
    const named = join(home.directory, OLD);
    await writeFile(named, 'x');
    const old = new Date(Date.now() - 31 * DAY);
    await utimes(named, old, old);
    const live: LiveLaunchCommands = {
      commands: async () => [['/wrapper', '--model', 'm', '--settings', named]],
    };

    // Act: another launch sweeps while the session is alive, then after it has ended.
    await filesOf(home, live).place({ name: NAME, content: 'now' }, { write: true });
    const whileAlive = (await readdir(home.directory)).sort();
    await filesOf(home).place({ name: NAME, content: 'now' }, { write: true });

    // Assert
    should(whileAlive).eql([NAME, OLD].sort());
    should(await readdir(home.directory)).eql([NAME]);
  });

  it('should keep every old launch file when the live sessions cannot be listed', async () => {
    // Arrange
    const home = await homeOf();
    await mkdir(home.directory, { recursive: true, mode: 0o700 });
    const named = join(home.directory, OLD);
    await writeFile(named, 'x');
    const old = new Date(Date.now() - 40 * DAY);
    await utimes(named, old, old);
    const unknown: LiveLaunchCommands = {
      commands: async () => {
        throw new Error('storage not open');
      },
    };

    // Act
    await filesOf(home, unknown).place({ name: NAME, content: 'now' }, { write: true });

    // Assert
    should((await readdir(home.directory)).sort()).eql([NAME, OLD].sort());
  });

  it('should count a file’s age from its last launch, which writes it fresh', async () => {
    // Arrange: a launch file written 40 days ago, launched again now, then another launch sweeps.
    const home = await homeOf();
    const files = filesOf(home);
    await files.place({ name: NAME, content: 'x' }, { write: true });
    const longAgo = new Date(Date.now() - 40 * DAY);
    await utimes(join(home.directory, NAME), longAgo, longAgo);
    await files.place({ name: NAME, content: 'x' }, { write: true });

    // Act
    await files.place({ name: OLD, content: 'y' }, { write: true });

    // Assert
    should((await readdir(home.directory)).sort()).eql([NAME, OLD].sort());
  });
});
