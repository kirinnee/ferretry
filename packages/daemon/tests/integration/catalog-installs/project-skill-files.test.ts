import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
