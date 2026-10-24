import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { NodeSkillFiles } from '../../../src/adapters/skills/index.ts';
import { MAX_SKILL_MANIFEST_BYTES, SkillsInventoryService } from '../../../src/lib/skills/inventory.ts';
import { sessionView } from '../../unit/runtime/mounts/support.ts';

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function skill(directory: string, name: string): Promise<void> {
  await mkdir(join(directory, name), { recursive: true });
  await writeFile(join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d ${name}\n---\n`, 'utf8');
}

describe('the skills inventory on a real tree', () => {
  it('reads a ferret’s home, marks links into the fleet assets and drops links that escape', async () => {
    root = await mkdtemp(join(tmpdir(), 'ferretry-skills-'));
    const fleet = join(root, 'fleet');
    const assets = join(fleet, 'assets');
    const home = join(fleet, 'homes', 'a');
    const outside = join(root, 'outside');
    await skill(join(assets, 'skills'), 'component');
    await skill(outside, 'escapee');
    await skill(join(home, 'skills'), 'own');
    await mkdir(join(home, 'skills', '.system'), { recursive: true });
    await symlink(join(assets, 'skills', 'component'), join(home, 'skills', 'component'));
    await symlink(join(outside, 'escapee'), join(home, 'skills', 'escapee'));
    const project = join(root, 'project');
    await skill(join(project, '.claude', 'skills'), 'local');
    await mkdir(join(project, '.claude', 'skills', 'broken'), { recursive: true });
    const service = new SkillsInventoryService({
      files: new NodeSkillFiles(),
      homes: async () => [{ runtimes: ['claude-a'], harness: 'claude', home }],
      projects: async () => [],
      fleetDirectory: fleet,
      assetsDirectory: assets,
      userHome: join(root, 'owner'),
    });

    const inventory = await service.session(
      sessionView('s1', { harness: 'claude', agent: join(fleet, 'bin', 'claude-a'), cwd: project }),
    );

    should(inventory.skills.map(entry => [entry.name, entry.scope])).deepEqual([
      ['component', 'ferretry'],
      ['own', 'user'],
      ['local', 'project'],
    ]);
  });

  it('refuses a file over the manifest cap', async () => {
    root = await mkdtemp(join(tmpdir(), 'ferretry-skills-'));
    await writeFile(join(root, 'big'), 'x'.repeat(MAX_SKILL_MANIFEST_BYTES + 1));
    await writeFile(join(root, 'small'), 'ok');

    should(await new NodeSkillFiles().read(join(root, 'big'), MAX_SKILL_MANIFEST_BYTES)).be.undefined();
    should(await new NodeSkillFiles().read(join(root, 'small'), MAX_SKILL_MANIFEST_BYTES)).equal('ok');
  });
});
