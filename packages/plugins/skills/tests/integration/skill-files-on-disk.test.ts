/**
 * Skill folders and SKILL.md reads through the kernel's REAL root handle over a temp folder: a link that leaves the
 * folder is neither listed nor read, and a missing or oversized file is an empty answer, as before.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskRoot } from '@ferretry/kernel/testing';
import { RootSkillFiles } from '../../daemon/adapters/skill-files.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function world() {
  const parent = await mkdtemp(join(tmpdir(), 'fy-skill-files-'));
  parents.push(parent);
  const { root, folder } = await diskRoot(parent);
  const skills = join(folder, 'skills');
  await mkdir(skills, { recursive: true });
  const skill = async (name: string, text = `# ${name}\n`) => {
    await mkdir(join(skills, name), { recursive: true });
    await writeFile(join(skills, name, 'SKILL.md'), text);
  };
  return { parent, folder, skills, skill, files: new RootSkillFiles(root, folder) };
}

describe('listing skill folders', () => {
  test('lists the folders that hold a SKILL.md, sorted, skipping dot-entries, bare folders and plain files', async () => {
    const { skills, skill, files } = await world();
    await skill('zeta');
    await skill('alpha');
    await skill('.hidden');
    await mkdir(join(skills, 'bare'));
    await writeFile(join(skills, 'notes.txt'), 'not a skill');
    await mkdir(join(skills, 'wrong-kind'));
    await mkdir(join(skills, 'wrong-kind', 'SKILL.md'));

    const listed = await files.list(skills, 10);

    expect(listed).toEqual([{ manifest: `${skills}/alpha/SKILL.md` }, { manifest: `${skills}/zeta/SKILL.md` }]);
  });

  test('stops one past the limit, so the caller can tell there were more', async () => {
    const { skills, skill, files } = await world();
    for (const name of ['a', 'b', 'c', 'd', 'e']) await skill(name);

    const listed = await files.list(skills, 2);

    expect(listed.map(entry => entry.manifest)).toEqual([
      `${skills}/a/SKILL.md`,
      `${skills}/b/SKILL.md`,
      `${skills}/c/SKILL.md`,
    ]);
  });

  test('lists nothing for a missing folder or one outside the root, and never follows a link out of it', async () => {
    const { parent, folder, skills, skill, files } = await world();
    await skill('real');
    await mkdir(join(parent, 'elsewhere', 'stolen'), { recursive: true });
    await writeFile(join(parent, 'elsewhere', 'stolen', 'SKILL.md'), '# stolen');
    await symlink(join(parent, 'elsewhere', 'stolen'), join(skills, 'linked-out'));

    expect(await files.list(join(folder, 'no-such-folder'), 10)).toEqual([]);
    expect(await files.list(parent, 10)).toEqual([]);
    expect((await files.list(skills, 10)).map(entry => entry.manifest)).toEqual([`${skills}/real/SKILL.md`]);
  });
});

describe('reading a SKILL.md', () => {
  test('reads a regular file inside the root', async () => {
    const { skills, skill, files } = await world();
    await skill('alpha', '# Alpha\nUse it well.\n');

    expect(await files.read(`${skills}/alpha/SKILL.md`, 1_000)).toBe('# Alpha\nUse it well.\n');
  });

  test('answers nothing for a missing file, a folder, an oversized file, a path outside the root and a link out of it', async () => {
    const { parent, skills, skill, files } = await world();
    await skill('big', 'x'.repeat(500));
    await mkdir(join(parent, 'elsewhere'));
    await writeFile(join(parent, 'elsewhere', 'secret.md'), '# secret');
    await mkdir(join(skills, 'sneaky'));
    await symlink(join(parent, 'elsewhere', 'secret.md'), join(skills, 'sneaky', 'SKILL.md'));

    expect(await files.read(`${skills}/missing/SKILL.md`, 1_000)).toBeUndefined();
    expect(await files.read(`${skills}/big`, 1_000)).toBeUndefined();
    expect(await files.read(`${skills}/big/SKILL.md`, 100)).toBeUndefined();
    expect(await files.read(join(parent, 'elsewhere', 'secret.md'), 1_000)).toBeUndefined();
    expect(await files.read(`${skills}/sneaky/SKILL.md`, 1_000)).toBeUndefined();
  });
});
