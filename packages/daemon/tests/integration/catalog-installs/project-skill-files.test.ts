import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileProjectSkillFiles } from '../../../src/adapters/catalog-installs/project-skill-files.ts';

/** The project-side skill folder: `<root>/.agents/skills/<name>`, with every rule from skill-folder.ts. */

const FOLDER = '.agents/skills/pdf-tools';
const roots = new Set<string>();

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-project-skill-'));
  roots.add(root);
  return root;
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe('FileProjectSkillFiles', () => {
  it('should inspect a folder that is not there, and one that is', async () => {
    // Arrange
    const root = await project();
    const files = new FileProjectSkillFiles();

    // Act
    const absent = await files.inspect(root, FOLDER);
    await mkdir(join(root, FOLDER), { recursive: true });
    await writeFile(join(root, FOLDER, 'SKILL.md'), '# skill\n', 'utf8');
    const present = await files.inspect(root, FOLDER);

    // Assert
    should(absent.exists).be.false();
    should(present.exists).be.true();
    should([...present.files.keys()]).deepEqual(['SKILL.md']);
  });

  it('should apply a change with the default temporary names, then remove it', async () => {
    // Arrange
    const root = await project();
    const files = new FileProjectSkillFiles();

    // Act
    await files.apply(root, FOLDER, {
      write: [{ path: 'SKILL.md', content: '# skill\n' }],
      remove: [],
      expected: new Map([['SKILL.md', null]]),
    });
    const written = await readFile(join(root, FOLDER, 'SKILL.md'), 'utf8');
    const reading = await files.inspect(root, FOLDER);
    await files.apply(root, FOLDER, {
      write: [],
      remove: ['SKILL.md'],
      expected: new Map([['SKILL.md', reading.files.get('SKILL.md') ?? null]]),
    });

    // Assert
    should(written).equal('# skill\n');
    should(await readdir(join(root, '.agents/skills'))).deepEqual([]);
  });

  it('should use the temporary names it was given', async () => {
    // Arrange
    const root = await project();
    await mkdir(join(root, FOLDER), { recursive: true });
    await writeFile(join(root, FOLDER, '.taken.tmp'), 'x', 'utf8');
    const files = new FileProjectSkillFiles(() => 'taken');

    // Act
    const error = await files
      .apply(root, FOLDER, {
        write: [{ path: 'SKILL.md', content: 'a' }],
        remove: [],
        expected: new Map([['SKILL.md', null]]),
      })
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    // Assert
    should((error as NodeJS.ErrnoException).code).equal('EEXIST');
  });
});

describe('FileProjectSkillFiles.read', () => {
  it('should read named files as text, skip absent ones, and mark a file that is not text as too large to show', async () => {
    // Arrange
    const root = await project();
    await mkdir(join(root, FOLDER, 'scripts'), { recursive: true });
    await writeFile(join(root, FOLDER, 'SKILL.md'), 'hello', 'utf8');
    await writeFile(join(root, FOLDER, 'scripts', 'run.sh'), 'echo', 'utf8');
    await writeFile(join(root, FOLDER, 'blob.bin'), new Uint8Array([0xff, 0xfe, 0x00]));
    await writeFile(join(root, FOLDER, 'big.txt'), 'x'.repeat(256 * 1024 + 1), 'utf8');
    const files = new FileProjectSkillFiles();

    // Act
    const reading = await files.read(root, FOLDER, [
      'SKILL.md',
      'scripts/run.sh',
      'gone.md',
      'nope/deeper.md',
      'blob.bin',
      'big.txt',
      'SKILL.md',
    ]);

    // Assert
    should([...reading.files]).deepEqual([
      ['SKILL.md', 'hello'],
      ['scripts/run.sh', 'echo'],
    ]);
    should(reading.tooLarge).deepEqual(['blob.bin', 'big.txt']);
  });

  it('should read a file of exactly the largest size, and mark one byte more as too large to show', async () => {
    // Arrange
    const root = await project();
    await mkdir(join(root, FOLDER), { recursive: true });
    const cap = 256 * 1024;
    await writeFile(join(root, FOLDER, 'exact.txt'), 'z'.repeat(cap), 'utf8');
    await writeFile(join(root, FOLDER, 'over.txt'), 'z'.repeat(cap + 1), 'utf8');

    // Act
    const reading = await new FileProjectSkillFiles().read(root, FOLDER, ['exact.txt', 'over.txt']);

    // Assert
    should([...reading.files.keys()]).deepEqual(['exact.txt']);
    should(reading.files.get('exact.txt')?.length).equal(cap);
    should(reading.tooLarge).deepEqual(['over.txt']);
  });

  it('should mark a file past the total a skill may hold as too large to show', async () => {
    // Arrange
    const root = await project();
    await mkdir(join(root, FOLDER), { recursive: true });
    const names = Array.from({ length: 9 }, (_, index) => `part-${index}.txt`);
    for (const name of names) await writeFile(join(root, FOLDER, name), 'y'.repeat(250 * 1024), 'utf8');

    // Act
    const reading = await new FileProjectSkillFiles().read(root, FOLDER, names);

    // Assert
    should(reading.files.size).equal(8);
    should(reading.tooLarge).deepEqual(['part-8.txt']);
  });

  it('should refuse a path that leaves the folder, and one that goes through a link', async () => {
    // Arrange
    const root = await project();
    await mkdir(join(root, FOLDER), { recursive: true });
    await symlink('/etc', join(root, FOLDER, 'out'));
    await symlink('/etc/hostname', join(root, FOLDER, 'peek.txt'));
    const files = new FileProjectSkillFiles();

    // Act
    const escaping = await files.read(root, FOLDER, ['../x']).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    const viaDirectory = await files.read(root, FOLDER, ['out/hostname']).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    const viaFile = await files.read(root, FOLDER, ['peek.txt']).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // Assert
    should(escaping).be.instanceOf(Error);
    should(viaDirectory).be.instanceOf(Error);
    should(viaFile).be.instanceOf(Error);
  });
});
