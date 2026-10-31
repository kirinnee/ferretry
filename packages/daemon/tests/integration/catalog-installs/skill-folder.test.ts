import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  applySkillFolder,
  inspectSkillFolder,
  MAX_SKILL_FOLDER_BYTES,
  MAX_SKILL_FOLDER_FILES,
} from '../../../src/adapters/catalog-installs/skill-folder.ts';
import { SkillFolderChanged, SkillFolderRefused } from '../../../src/lib/catalog-installs/ports.ts';

/**
 * The shared skill-folder rules over real directories: never through a link, only plain files, bounded,
 * compared before it is swapped, and written by temp + rename.
 */

const FOLDER = '.claude/skills/pdf-tools';
const roots = new Set<string>();

async function project(): Promise<{ readonly root: string; readonly folder: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-skill-folder-'));
  roots.add(root);
  return { root, folder: join(root, FOLDER) };
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

const sha = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

const settle = async <T>(work: Promise<T>): Promise<unknown> =>
  await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

async function seed(folder: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(folder, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

describe('inspectSkillFolder', () => {
  it('should say a folder that is not there is not there, however many of its parents are missing', async () => {
    // Arrange
    const { root } = await project();

    // Act
    const reading = await inspectSkillFolder(root, FOLDER);

    // Assert
    should(reading.exists).be.false();
    should([...reading.files]).deepEqual([]);
  });

  it('should hash every file below the folder by its relative path', async () => {
    // Arrange
    const { root, folder } = await project();
    await seed(folder, { 'SKILL.md': '# skill\n', 'scripts/split.sh': 'echo split\n' });

    // Act
    const reading = await inspectSkillFolder(root, FOLDER);

    // Assert
    should(reading.exists).be.true();
    should(Object.fromEntries(reading.files)).deepEqual({
      'SKILL.md': sha('# skill\n'),
      'scripts/split.sh': sha('echo split\n'),
    });
  });

  it('should refuse a symbolic link anywhere from the root down to the folder', async () => {
    // Arrange
    const { root } = await project();
    const elsewhere = await mkdtemp(join(tmpdir(), 'ferretry-skill-elsewhere-'));
    roots.add(elsewhere);
    await mkdir(join(elsewhere, 'skills', 'pdf-tools'), { recursive: true });
    await symlink(elsewhere, join(root, '.claude'));

    // Act
    const error = await settle(inspectSkillFolder(root, FOLDER));

    // Assert
    should(error).be.instanceOf(SkillFolderRefused);
    should((error as Error).message).match(/is a symbolic link, and Ferretry will not follow it/u);
  });

  it('should refuse a file where a folder should be', async () => {
    // Arrange
    const { root } = await project();
    await writeFile(join(root, '.claude'), 'not a folder', 'utf8');

    // Act
    const error = await settle(inspectSkillFolder(root, FOLDER));

    // Assert
    should(error).be.instanceOf(SkillFolderRefused);
    should((error as Error).message).match(/is not a folder, so a skill cannot go there/u);
  });

  it('should refuse a link inside the folder rather than skip it', async () => {
    // Arrange
    const { root, folder } = await project();
    await seed(folder, { 'SKILL.md': '# skill\n' });
    await symlink(join(folder, 'SKILL.md'), join(folder, 'alias.md'));

    // Act
    const error = await settle(inspectSkillFolder(root, FOLDER));

    // Assert
    should(error).be.instanceOf(SkillFolderRefused);
    should((error as Error).message).match(/is not a plain file or folder/u);
  });

  it('should refuse a special file such as a named pipe', async () => {
    // Arrange
    const { root, folder } = await project();
    await seed(folder, { 'SKILL.md': '# skill\n' });
    const made = Bun.spawnSync(['mkfifo', join(folder, 'pipe')]);
    should(made.exitCode).equal(0);

    // Act
    const error = await settle(inspectSkillFolder(root, FOLDER));

    // Assert
    should(error).be.instanceOf(SkillFolderRefused);
  });

  it('should refuse a folder with more files than a skill can have', async () => {
    // Arrange
    const { root, folder } = await project();
    await mkdir(folder, { recursive: true });
    for (let n = 0; n <= MAX_SKILL_FOLDER_FILES; n += 1) await writeFile(join(folder, `f${n}.txt`), 'x', 'utf8');

    // Act
    const error = await settle(inspectSkillFolder(root, FOLDER));

    // Assert
    should(error).be.instanceOf(SkillFolderRefused);
    should((error as Error).message).match(/holds more than a skill can/u);
  });

  it('should accept exactly the most files a skill can have', async () => {
    // Arrange
    const { root, folder } = await project();
    await mkdir(folder, { recursive: true });
    for (let n = 0; n < MAX_SKILL_FOLDER_FILES; n += 1) await writeFile(join(folder, `f${n}.txt`), 'x', 'utf8');

    // Act
    const reading = await inspectSkillFolder(root, FOLDER);

    // Assert
    should(reading.files.size).equal(MAX_SKILL_FOLDER_FILES);
  });

  it('should refuse a single file, or several together, past the size a skill can be', async () => {
    // Arrange
    const single = await project();
    await mkdir(single.folder, { recursive: true });
    await writeFile(join(single.folder, 'big.bin'), Buffer.alloc(MAX_SKILL_FOLDER_BYTES + 1));
    const together = await project();
    await mkdir(together.folder, { recursive: true });
    await writeFile(join(together.folder, 'a.bin'), Buffer.alloc(MAX_SKILL_FOLDER_BYTES / 2 + 1));
    await writeFile(join(together.folder, 'b.bin'), Buffer.alloc(MAX_SKILL_FOLDER_BYTES / 2 + 1));

    // Act
    const one = await settle(inspectSkillFolder(single.root, FOLDER));
    const two = await settle(inspectSkillFolder(together.root, FOLDER));

    // Assert
    should(one).be.instanceOf(SkillFolderRefused);
    should((one as Error).message).match(/is larger than a skill file can be/u);
    should(two).be.instanceOf(SkillFolderRefused);
    should((two as Error).message).match(/holds more than a skill can/u);
  });
});

describe('applySkillFolder', () => {
  it('should create a new folder with its files, at the mode a plain file gets, leaving no temporary file', async () => {
    // Arrange
    const { root, folder } = await project();

    // Act
    await applySkillFolder(root, FOLDER, {
      write: [
        { path: 'SKILL.md', content: '# skill\n' },
        { path: 'scripts/split.sh', content: 'echo split\n' },
      ],
      remove: [],
      expected: new Map([
        ['SKILL.md', null],
        ['scripts/split.sh', null],
      ]),
    });

    // Assert
    should(await readFile(join(folder, 'SKILL.md'), 'utf8')).equal('# skill\n');
    should(await readFile(join(folder, 'scripts/split.sh'), 'utf8')).equal('echo split\n');
    should((await stat(join(folder, 'SKILL.md'))).mode & 0o777).equal(0o644);
    should((await readdir(folder)).sort()).deepEqual(['SKILL.md', 'scripts']);
    should(await readdir(join(folder, 'scripts'))).deepEqual(['split.sh']);
  });

  it('should replace a file that is still what the review showed', async () => {
    // Arrange
    const { root, folder } = await project();
    await seed(folder, { 'SKILL.md': 'old\n' });

    // Act
    await applySkillFolder(root, FOLDER, {
      write: [{ path: 'SKILL.md', content: 'new\n' }],
      remove: [],
      expected: new Map([['SKILL.md', sha('old\n')]]),
    });

    // Assert
    should(await readFile(join(folder, 'SKILL.md'), 'utf8')).equal('new\n');
  });

  it('should write nothing when a file was edited since the review', async () => {
    // Arrange
    const { root, folder } = await project();
    await seed(folder, { 'SKILL.md': 'edited by hand\n', 'other.md': 'other\n' });

    // Act
    const error = await settle(
      applySkillFolder(root, FOLDER, {
        write: [{ path: 'other.md', content: 'new\n' }],
        remove: [],
        expected: new Map([
          ['SKILL.md', sha('old\n')],
          ['other.md', sha('other\n')],
        ]),
      }),
    );

    // Assert
    should(error).be.instanceOf(SkillFolderChanged);
    should(await readFile(join(folder, 'other.md'), 'utf8')).equal('other\n');
  });

  it('should write nothing when a file that must be absent has appeared', async () => {
    // Arrange
    const { root, folder } = await project();
    await seed(folder, { 'SKILL.md': 'appeared\n' });

    // Act
    const error = await settle(
      applySkillFolder(root, FOLDER, {
        write: [{ path: 'SKILL.md', content: 'new\n' }],
        remove: [],
        expected: new Map([['SKILL.md', null]]),
      }),
    );

    // Assert
    should(error).be.instanceOf(SkillFolderChanged);
    should(await readFile(join(folder, 'SKILL.md'), 'utf8')).equal('appeared\n');
  });

  it('should remove files and prune the directories that emptied, up to and including the skill folder', async () => {
    // Arrange
    const { root, folder } = await project();
    await seed(folder, { 'SKILL.md': 'a\n', 'scripts/deep/split.sh': 'b\n' });

    // Act
    await applySkillFolder(root, FOLDER, {
      write: [],
      remove: ['SKILL.md', 'scripts/deep/split.sh'],
      expected: new Map([
        ['SKILL.md', sha('a\n')],
        ['scripts/deep/split.sh', sha('b\n')],
      ]),
    });

    // Assert — the skill folder is gone; the folders the project owns are not touched.
    await should(stat(folder)).be.rejected();
    should((await stat(join(root, '.claude/skills'))).isDirectory()).be.true();
  });

  it('should keep a directory that still holds something the person added', async () => {
    // Arrange
    const { root, folder } = await project();
    await seed(folder, { 'scripts/split.sh': 'b\n', 'scripts/mine.sh': 'mine\n' });

    // Act
    await applySkillFolder(root, FOLDER, {
      write: [],
      remove: ['scripts/split.sh'],
      expected: new Map([['scripts/split.sh', sha('b\n')]]),
    });

    // Assert
    should(await readdir(join(folder, 'scripts'))).deepEqual(['mine.sh']);
  });

  it('should refuse to write over a name that is a directory, and leave no temporary file behind', async () => {
    // Arrange
    const { root, folder } = await project();
    await mkdir(join(folder, 'SKILL.md'), { recursive: true });

    // Act
    const error = await settle(
      applySkillFolder(root, FOLDER, {
        write: [{ path: 'SKILL.md', content: 'new\n' }],
        remove: [],
        expected: new Map([['SKILL.md', null]]),
      }),
    );

    // Assert
    should(error).be.instanceOf(SkillFolderRefused);
    should((error as Error).message).match(/is not a plain file, so Ferretry will not replace it/u);
    should(await readdir(folder)).deepEqual(['SKILL.md']);
  });

  it('should refuse a temporary name that is already taken, rather than write through it', async () => {
    // Arrange
    const { root, folder } = await project();
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, '.fixed.tmp'), 'someone else', 'utf8');

    // Act
    const error = await settle(
      applySkillFolder(
        root,
        FOLDER,
        { write: [{ path: 'SKILL.md', content: 'new\n' }], remove: [], expected: new Map([['SKILL.md', null]]) },
        () => 'fixed',
      ),
    );

    // Assert
    should((error as NodeJS.ErrnoException).code).equal('EEXIST');
    should(await readFile(join(folder, '.fixed.tmp'), 'utf8')).equal('someone else');
  });

  it('should refuse a link on the way to the folder before writing anything', async () => {
    // Arrange
    const { root } = await project();
    const elsewhere = await mkdtemp(join(tmpdir(), 'ferretry-skill-elsewhere-'));
    roots.add(elsewhere);
    await symlink(elsewhere, join(root, '.claude'));

    // Act
    const error = await settle(
      applySkillFolder(root, FOLDER, {
        write: [{ path: 'SKILL.md', content: 'new\n' }],
        remove: [],
        expected: new Map([['SKILL.md', null]]),
      }),
    );

    // Assert
    should(error).be.instanceOf(SkillFolderRefused);
    should(await readdir(elsewhere)).deepEqual([]);
  });

  it('should refuse a link inside the folder before writing anything', async () => {
    // Arrange
    const { root, folder } = await project();
    await seed(folder, { 'SKILL.md': 'old\n' });
    await symlink(join(folder, 'SKILL.md'), join(folder, 'alias.md'));

    // Act
    const error = await settle(
      applySkillFolder(root, FOLDER, {
        write: [{ path: 'SKILL.md', content: 'new\n' }],
        remove: [],
        expected: new Map([['SKILL.md', sha('old\n')]]),
      }),
    );

    // Assert
    should(error).be.instanceOf(SkillFolderRefused);
    should(await readFile(join(folder, 'SKILL.md'), 'utf8')).equal('old\n');
  });

  it('should not fail when a directory it would prune is already gone', async () => {
    // Arrange
    const { root, folder } = await project();
    await seed(folder, { 'SKILL.md': 'a\n' });

    // Act — removing a file that was never there is not an error either.
    await applySkillFolder(root, FOLDER, {
      write: [],
      remove: ['gone/never.md'],
      expected: new Map([['gone/never.md', null]]),
    });

    // Assert
    should(await readdir(folder)).deepEqual(['SKILL.md']);
  });
});
