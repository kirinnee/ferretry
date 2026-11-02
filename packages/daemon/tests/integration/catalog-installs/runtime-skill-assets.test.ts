import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { SkillFolderChanged } from '../../../src/lib/catalog-installs/ports.ts';
import { FileRuntimeSkillAssets } from '../../../src/adapters/catalog-installs/runtime-skill-assets.ts';

/** `<fleet>/assets/skills/<name>`: read, and prune the files an old install left. */

const roots = new Set<string>();

const sha = (text: string): string => new Bun.CryptoHasher('sha256').update(text).digest('hex');

async function skills(): Promise<{ readonly directory: string; readonly assets: FileRuntimeSkillAssets }> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-runtime-skill-'));
  roots.add(root);
  const directory = join(root, 'assets', 'skills');
  await mkdir(directory, { recursive: true });
  return { directory, assets: new FileRuntimeSkillAssets(directory) };
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

describe('FileRuntimeSkillAssets', () => {
  it('should inspect a skill the fleet holds, and one it does not', async () => {
    // Arrange
    const { directory, assets } = await skills();
    await mkdir(join(directory, 'pdf-tools'));
    await writeFile(join(directory, 'pdf-tools', 'SKILL.md'), '# skill\n', 'utf8');

    // Act
    const present = await assets.inspect('pdf-tools');
    const absent = await assets.inspect('nothing');

    // Assert
    should([...present.files.keys()]).deepEqual(['SKILL.md']);
    should(absent.exists).be.false();
  });

  it('should refuse, and create nothing, for a skill that is not there but was verified as there', async () => {
    // Arrange
    const { directory, assets } = await skills();

    // Act
    const removing = assets.remove('nothing', new Map([['SKILL.md', sha('# skill\n')]]));

    // Assert
    await should(removing).be.rejectedWith(SkillFolderChanged);
    should(await readdir(directory)).deepEqual([]);
  });

  it('should refuse a file that is no longer what the caller verified, and delete none of them', async () => {
    // Arrange
    const { directory, assets } = await skills();
    await mkdir(join(directory, 'pdf-tools'));
    await writeFile(join(directory, 'pdf-tools', 'SKILL.md'), '# edited since\n', 'utf8');
    await writeFile(join(directory, 'pdf-tools', 'other.md'), 'x\n', 'utf8');

    // Act
    const removing = assets.remove(
      'pdf-tools',
      new Map([
        ['other.md', sha('x\n')],
        ['SKILL.md', sha('# skill\n')],
      ]),
    );

    // Assert
    await should(removing).be.rejectedWith(SkillFolderChanged);
    should((await readdir(join(directory, 'pdf-tools'))).toSorted()).deepEqual(['SKILL.md', 'other.md']);
  });

  it('should delete exactly the named files and the folder once it is empty', async () => {
    // Arrange
    const { directory, assets } = await skills();
    await mkdir(join(directory, 'pdf-tools', 'scripts'), { recursive: true });
    await writeFile(join(directory, 'pdf-tools', 'SKILL.md'), '# skill\n', 'utf8');
    await writeFile(join(directory, 'pdf-tools', 'scripts', 'split.sh'), 'echo\n', 'utf8');

    // Act
    await assets.remove(
      'pdf-tools',
      new Map([
        ['SKILL.md', sha('# skill\n')],
        ['scripts/split.sh', sha('echo\n')],
      ]),
    );

    // Assert
    await should(stat(join(directory, 'pdf-tools'))).be.rejected();
    should((await stat(directory)).isDirectory()).be.true();
  });

  it('should keep the folder, and the files it was not told about', async () => {
    // Arrange
    const { directory, assets } = await skills();
    await mkdir(join(directory, 'pdf-tools'));
    await writeFile(join(directory, 'pdf-tools', 'SKILL.md'), '# skill\n', 'utf8');
    await writeFile(join(directory, 'pdf-tools', 'extra.md'), 'kept\n', 'utf8');

    // Act
    await assets.remove('pdf-tools', new Map([['SKILL.md', sha('# skill\n')]]));

    // Assert
    should(await readdir(join(directory, 'pdf-tools'))).deepEqual(['extra.md']);
  });
});

describe('FileRuntimeSkillAssets.read', () => {
  it('should read the named files of a skill the fleet holds, and nothing of one it does not', async () => {
    // Arrange
    const { directory, assets } = await skills();
    await mkdir(join(directory, 'pdf-tools'));
    await writeFile(join(directory, 'pdf-tools', 'SKILL.md'), '# skill\n', 'utf8');

    // Act
    const present = await assets.read('pdf-tools', ['SKILL.md', 'other.md']);
    const absent = await assets.read('nothing', ['SKILL.md']);

    // Assert
    should([...present.files]).deepEqual([['SKILL.md', '# skill\n']]);
    should(present.tooLarge).deepEqual([]);
    should(absent.files.size).equal(0);
  });
});
