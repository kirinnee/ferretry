/**
 * A registered project's skills read through the kernel's REAL read-only `imports` root on a temp disk (never a real home):
 * the folder the root is scoped to is the skills folder itself, so a link planted in it, a hard-linked SKILL.md, or a
 * skills folder that is itself a link reads nothing, and a file beside the skills folder is unreachable.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { renameSync, symlinkSync } from 'node:fs';
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HostFs, nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../core/kernel/host/roots.ts';
import { ProjectSkillFiles } from '../../daemon/adapters/project-skill-files.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const doc = (name: string): string => `---\nname: ${name}\ndescription: does ${name}\n---\n`;
const SECRET = 'SECRET-OUTSIDE-THE-PROJECT';

async function world() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-project-skills-`));
  parents.push(parent);
  const home = join(parent, 'home');
  const project = join(parent, 'project');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(join(project, '.claude', 'skills', 'good'), { recursive: true });
  await writeFile(join(project, '.claude', 'skills', 'good', 'SKILL.md'), doc('good'));
  await writeFile(join(project, '.claude', 'skills', 'good', 'notes.md'), 'notes');
  await writeFile(join(project, 'secret.txt'), SECRET);
  await mkdir(join(parent, 'outside', 'steal'), { recursive: true });
  await writeFile(join(parent, 'outside', 'steal', 'SKILL.md'), doc('steal'));
  const rootsOver = (disk: HostFs) =>
    rootsPortFor(disk, { home, plugin: 'skills', worktrees: `${home}-w` }, ['imports'], () => undefined);
  const roots = rootsOver(nodeFs(() => crypto.randomUUID()));
  /** Opens exactly as the daemon half wires it: the registered project folder is the `within` anchor. */
  const opened = (port: typeof roots) => (folder: string, within: string) =>
    port.root('imports', { subfolder: folder, within });
  const files = (known: readonly string[] = [project]) => new ProjectSkillFiles(async () => known, opened(roots));
  /** The same reader over a disk seam of the test's own (a swap that lands at an exact step). */
  const filesOver = (disk: HostFs, known: readonly string[] = [project]) =>
    new ProjectSkillFiles(async () => known, opened(rootsOver(disk)));
  return { parent, project, skills: join(project, '.claude', 'skills'), files, filesOver };
}

describe('a registered project’s skills over the real imports root', () => {
  test('R-0198 lists and reads a plain skill folder’s SKILL.md, and nothing else of the project', async () => {
    const w = await world();
    const files = w.files();
    expect((await files.list(w.skills, 10)).map(entry => entry.manifest)).toEqual([`${w.skills}/good/SKILL.md`]);
    expect(await files.read(`${w.skills}/good/SKILL.md`, 1000)).toBe(doc('good'));
    expect(await files.read(`${w.skills}/good/notes.md`, 1000)).toBeUndefined();
    expect(await files.read(`${w.project}/secret.txt`, 1000)).toBeUndefined();
    expect(await files.read(`${w.skills}/../../secret.txt`, 1000)).toBeUndefined();
    expect(await files.read(`${w.skills}/good/SKILL.md`, 5)).toBeUndefined();
  });

  test('R-0198 a link out of the skills folder is neither listed nor read; a link to another folder inside it stays inside', async () => {
    const w = await world();
    await symlink(join(w.parent, 'outside', 'steal'), join(w.skills, 'planted'));
    await symlink(join(w.project, 'secret.txt'), join(w.skills, 'secret-link'));
    await symlink(join(w.skills, 'good'), join(w.skills, 'twin'));
    const files = w.files();
    // As v4: a link whose target stays inside the folder is listed (it cannot reach anything the folder does not hold).
    expect((await files.list(w.skills, 10)).map(entry => entry.manifest)).toEqual([
      `${w.skills}/good/SKILL.md`,
      `${w.skills}/twin/SKILL.md`,
    ]);
    expect(await files.read(`${w.skills}/twin/SKILL.md`, 1000)).toBe(doc('good'));
    expect(await files.read(`${w.skills}/planted/SKILL.md`, 1000)).toBeUndefined();
    expect(await files.read(`${w.skills}/secret-link/SKILL.md`, 1000)).toBeUndefined();
  });

  test('R-0198 a SKILL.md with a second name, or one that is a link out, is never read', async () => {
    const w = await world();
    await mkdir(join(w.skills, 'hard'));
    await link(join(w.project, 'secret.txt'), join(w.skills, 'hard', 'SKILL.md'));
    await mkdir(join(w.skills, 'soft'));
    await symlink(join(w.parent, 'outside', 'steal', 'SKILL.md'), join(w.skills, 'soft', 'SKILL.md'));
    const files = w.files();
    // The hard-linked manifest may be listed, but the kernel refuses to read it, so no text (and no inventory row) follows.
    expect((await files.list(w.skills, 10)).map(entry => entry.manifest)).not.toContain(`${w.skills}/soft/SKILL.md`);
    expect(await files.read(`${w.skills}/hard/SKILL.md`, 1000)).toBeUndefined();
    expect(await files.read(`${w.skills}/soft/SKILL.md`, 1000)).toBeUndefined();
  });

  // The kernel refuses a link below the project folder (the `within` anchor) at every call. Each link points at a REAL
  // skills tree (`<name>/SKILL.md`), so without the anchor the stolen skill would be listed and read.
  test('R-0198 a skills folder that is itself a link to a real skills tree answers nothing', async () => {
    const w = await world();
    await mkdir(join(w.parent, 'outside', 'skills', 'stolen'), { recursive: true });
    await writeFile(join(w.parent, 'outside', 'skills', 'stolen', 'SKILL.md'), doc('stolen'));
    await rm(join(w.project, '.claude'), { recursive: true });
    await mkdir(join(w.project, '.claude'));
    await symlink(join(w.parent, 'outside', 'skills'), w.skills);
    const files = w.files();
    expect(await files.list(w.skills, 10)).toEqual([]);
    expect(await files.read(`${w.skills}/stolen/SKILL.md`, 1000)).toBeUndefined();
  });

  test('R-0198 a skills folder that sits under a link to a real skills tree answers nothing', async () => {
    const w = await world();
    await mkdir(join(w.parent, 'outside', 'claude', 'skills', 'stolen'), { recursive: true });
    await writeFile(join(w.parent, 'outside', 'claude', 'skills', 'stolen', 'SKILL.md'), doc('stolen'));
    await rm(join(w.project, '.claude'), { recursive: true });
    await symlink(join(w.parent, 'outside', 'claude'), join(w.project, '.claude'));
    const files = w.files();
    expect(await files.list(w.skills, 10)).toEqual([]);
    expect(await files.read(`${w.skills}/stolen/SKILL.md`, 1000)).toBeUndefined();
  });

  test.each([
    ['.claude', 'at .claude'],
    ['.agents', 'at .agents'],
  ])('R-0198 a link %s in the middle of the path answers nothing, whichever skills folder it holds', async dir => {
    const w = await world();
    const outside = join(w.parent, 'outside', 'hold');
    await mkdir(join(outside, 'skills', 'stolen'), { recursive: true });
    await writeFile(join(outside, 'skills', 'stolen', 'SKILL.md'), doc('stolen'));
    await rm(join(w.project, '.claude'), { recursive: true });
    await symlink(outside, join(w.project, dir));
    const skills = join(w.project, dir, 'skills');
    const files = w.files();
    expect(await files.list(skills, 10)).toEqual([]);
    expect(await files.read(`${skills}/stolen/SKILL.md`, 1000)).toBeUndefined();
  });

  test('R-0198 a skills folder that is a dangling link, or a link in a loop, answers nothing', async () => {
    const w = await world();
    await rm(join(w.project, '.claude'), { recursive: true });
    await mkdir(join(w.project, '.claude'));
    await symlink(join(w.parent, 'nowhere'), w.skills);
    const files = w.files();
    expect(await files.list(w.skills, 10)).toEqual([]);
    expect(await files.read(`${w.skills}/good/SKILL.md`, 1000)).toBeUndefined();
    await rm(w.skills);
    await symlink(w.skills, w.skills);
    expect(await files.list(w.skills, 10)).toEqual([]);
  });

  test('R-B1 a project registered through a link, or under a linked parent, still lists and reads its skills', async () => {
    const w = await world();
    const linked = join(w.parent, 'linked-project');
    await symlink(w.project, linked);
    const parentLink = join(w.parent, 'linked-parent');
    await symlink(w.parent, parentLink);
    for (const root of [linked, join(parentLink, 'project')]) {
      const skills = join(root, '.claude', 'skills');
      const files = w.files([root]);
      expect((await files.list(skills, 10)).map(entry => entry.manifest)).toEqual([`${skills}/good/SKILL.md`]);
      expect(await files.read(`${skills}/good/SKILL.md`, 1000)).toBe(doc('good'));
    }
  });

  test('R-0198 the reader anchors the kernel at the registered project folder, whatever trailing slash it was registered with', async () => {
    const w = await world();
    const asked: { folder: string; within: string }[] = [];
    const spy = new ProjectSkillFiles(
      async () => [`${w.project}/`],
      (folder, within) => {
        asked.push({ folder, within });
        throw new Error('stop');
      },
    );
    await spy.list(w.skills, 10);
    await spy.read(`${w.skills}/good/SKILL.md`, 1000);
    expect(asked).toEqual([
      { folder: w.skills, within: w.project },
      { folder: w.skills, within: w.project },
    ]);
  });

  test('R-0198 a skills folder swapped for a link after an earlier answer is refused at the next call', async () => {
    const w = await world();
    const files = w.files();
    expect(await files.read(`${w.skills}/good/SKILL.md`, 1000)).toBe(doc('good'));
    await mkdir(join(w.parent, 'outside', 'skills', 'good'), { recursive: true });
    await writeFile(join(w.parent, 'outside', 'skills', 'good', 'SKILL.md'), doc('stolen'));
    await rename(w.skills, join(w.project, '.claude', 'skills-moved'));
    await symlink(join(w.parent, 'outside', 'skills'), w.skills);
    expect(await files.read(`${w.skills}/good/SKILL.md`, 1000)).toBeUndefined();
    expect(await files.list(w.skills, 10)).toEqual([]);
  });

  test('R-0198 a skills folder swapped for a link right after the kernel looked at it reads no outside text', async () => {
    const w = await world();
    await mkdir(join(w.parent, 'outside', 'skills', 'good'), { recursive: true });
    await writeFile(join(w.parent, 'outside', 'skills', 'good', 'SKILL.md'), doc('stolen'));
    const inner = nodeFs(() => crypto.randomUUID());
    let swapped = false;
    const racing = {
      ...inner,
      lstat: async (path: string) => {
        const found = await inner.lstat(path);
        if (!swapped && path === w.skills) {
          swapped = true;
          renameSync(w.skills, join(w.project, '.claude', 'skills-moved'));
          symlinkSync(join(w.parent, 'outside', 'skills'), w.skills);
        }
        return found;
      },
    } as HostFs;
    const text = await w.filesOver(racing).read(`${w.skills}/good/SKILL.md`, 1000);
    expect(swapped).toBe(true);
    expect(text).not.toBe(doc('stolen'));
  });

  test('R-0198 a kernel that refuses to open the folder reads nothing, and never throws', async () => {
    const w = await world();
    const refusing = new ProjectSkillFiles(
      async () => [w.project],
      () => {
        throw new Error('refused');
      },
    );
    expect(await refusing.list(w.skills, 10)).toEqual([]);
    expect(await refusing.read(`${w.skills}/good/SKILL.md`, 1000)).toBeUndefined();
  });

  test('R-0198 a root nobody registered, and a project with no skills folder, read nothing', async () => {
    const w = await world();
    expect(await w.files([]).list(w.skills, 10)).toEqual([]);
    expect(await w.files(['/somewhere/else']).read(`${w.skills}/good/SKILL.md`, 1000)).toBeUndefined();
    await rm(join(w.project, '.claude'), { recursive: true });
    expect(await w.files().list(w.skills, 10)).toEqual([]);
  });
});
