/**
 * ilr F1 (row 103): THE `within` ANCHOR LIVES ONLY IN THE DAEMON WIRING. `ProjectSkillFiles` takes an `open(folder, within)`
 * and every adapter test wires its own, so dropping `within` from `kernel.roots.root('imports', …)` in `daemon/index.ts`
 * survived the whole skills unit tier. This test builds the REAL daemon half (`skills.build`) over the kernel's real
 * `imports` root on a temp disk (fake data, never a real home) and asks the half's own `skills` provider what a registered
 * project lists and reads: with `<project>/.claude` a link out of the project, nothing of the folder it points at is listed
 * or read, and a plain `.agents/skills` folder beside it still is (so the test is not an empty-world pass).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../core/kernel/host/roots.ts';
import { SKILLS_INSTALLED_STATE } from '../../contract/index.ts';
import skills from '../../daemon/index.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const doc = (name: string): string => `---\nname: ${name}\ndescription: does ${name}\n---\n`;

async function composed() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-composed-skills-`));
  parents.push(parent);
  const home = join(parent, 'home');
  const project = join(parent, 'project');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(join(project, '.agents', 'skills', 'plain'), { recursive: true });
  await writeFile(join(project, '.agents', 'skills', 'plain', 'SKILL.md'), doc('plain'));
  await mkdir(join(parent, 'outside-claude', 'skills', 'steal'), { recursive: true });
  await writeFile(join(parent, 'outside-claude', 'skills', 'steal', 'SKILL.md'), doc('steal'));
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home, plugin: 'skills', worktrees: `${home}-w` },
    ['imports'],
    () => undefined,
  );
  const half = skills.build!({
    kernel: {
      roots,
      state: new MemoryStateFolder().port([SKILLS_INSTALLED_STATE]),
      config: { collection: () => new Map(), file: () => ({}) },
    },
    needs: { ferrets: new FakeFerrets() },
    uses: {
      runtimes: { current: () => undefined },
      projects: { current: () => ({ list: async () => [{ id: 'p1', name: 'proj', path: project }] }) },
    },
  } as never);
  const api = (half.provides as unknown as { skills: SkillsApiLike }).skills;
  return { parent, project, api };
}

interface SkillsApiLike {
  inventory(): Promise<{ projects: { skills: { name: string; path: string }[] }[] }>;
  file(path: string, ferret?: string): Promise<string | undefined>;
}

const listed = async (api: SkillsApiLike) =>
  (await api.inventory()).projects.flatMap(project => project.skills.map(skill => skill.name));

describe('the skills daemon half over the real imports root (ilr F1)', () => {
  test('R-0198 ilr F1 a registered project lists its plain skills folder, so the link case below is not an empty world', async () => {
    const w = await composed();
    expect(await listed(w.api)).toEqual(['plain']);
    expect(await w.api.file(`${w.project}/.agents/skills/plain/SKILL.md`)).toBe(doc('plain'));
  });

  test('R-0198 ilr F1 a project whose .claude is a link out of it lists nothing from it and reads nothing through it', async () => {
    const w = await composed();
    await symlink(join(w.parent, 'outside-claude'), join(w.project, '.claude'));
    // The project's own plain folder still lists; the linked `.claude` contributes nothing.
    expect(await listed(w.api)).toEqual(['plain']);
    expect(await w.api.file(`${w.project}/.claude/skills/steal/SKILL.md`)).toBeUndefined();
  });
});
