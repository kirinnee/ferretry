/**
 * The skill file router and Skills' installed store over REAL parts on a temp disk (never a real home): the kernel's
 * real state port for the installed store, the real read-only `imports` root for a registered project's skills
 * folders and a ferret's own folder. Runtimes' two readers (a published home, the fleet's asset tree) are the
 * contract's ports and are proved on the fleet's real root in Runtimes' own tests, so they are stood in here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ok } from '@ferretry/std';
import { state } from '@ferretry/kernel/host';
import type { StatePort } from '@ferretry/kernel/contract';
import type { RuntimeAssetSkills, RuntimeHome, RuntimeHomeReader } from '@ferretry/plugin-runtimes/contract';
import { nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../core/kernel/host/roots.ts';
import { SKILLS_INSTALLED_STATE } from '../../contract/index.ts';
import { InstalledSkillFiles } from '../../daemon/adapters/installed-store.ts';
import { ProjectSkillFiles } from '../../daemon/adapters/project-skill-files.ts';
import { RootSkillFiles } from '../../daemon/adapters/skill-files.ts';
import { SkillFilesRouter } from '../../daemon/adapters/skill-files-router.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const doc = (name: string): string => `---\nname: ${name}\ndescription: does ${name}\n---\n`;

async function world() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-skill-router-`));
  parents.push(parent);
  const home = join(parent, 'home');
  const project = join(parent, 'project');
  await mkdir(join(home, 'state', 'skills'), { recursive: true, mode: 0o700 });
  await mkdir(join(project, '.claude', 'skills', 'pp'), { recursive: true });
  await writeFile(join(project, '.claude', 'skills', 'pp', 'SKILL.md'), doc('pp'));
  const fs = nodeFs(() => crypto.randomUUID());
  const roots = rootsPortFor(fs, { home, plugin: 'skills', worktrees: `${home}-w` }, ['imports'], () => undefined);
  const port = state.createStatePort({
    home,
    pluginId: 'skills',
    files: [SKILLS_INSTALLED_STATE],
    fs: state.createNodeHostFs(),
  });
  await port.write(SKILLS_INSTALLED_STATE, doc('inst'), 'inst/SKILL.md');
  const fleetHome: RuntimeHome = {
    id: 'a',
    harness: 'claude-code',
    runtimes: ['claude-a' as never],
    home: join(parent, 'fleet', 'homes', 'a'),
    wrapper: join(parent, 'fleet', 'bin', 'claude-a'),
  };
  const assetManifest = join(parent, 'fleet', 'assets', 'skills', 'tool', 'SKILL.md');
  const reader = {
    skills: async () => [{ name: 'mine', manifest: `${fleetHome.home}/skills/mine/SKILL.md`, managed: false }],
    skillManifest: async (name: string) => `home text of ${name}`,
  } as unknown as RuntimeHomeReader;
  const assets: RuntimeAssetSkills = {
    skills: async () => [{ name: 'tool', manifest: assetManifest, managed: true }],
    skillManifest: async name => `asset text of ${name}`,
  };
  const projects = new ProjectSkillFiles(
    async () => [project],
    (folder, within) => roots.root('imports', { subfolder: folder, within }),
  );
  const installed = new InstalledSkillFiles(port);
  const router = (over: Record<string, unknown> = {}) =>
    new SkillFilesRouter({
      homes: async () => [fleetHome],
      home: id => (id === 'a' ? reader : undefined),
      assets: () => assets,
      installed,
      projects,
      ...over,
    });
  return { parent, home, project, port, roots, fleetHome, assetManifest, reader, assets, installed, router };
}

/** The real state port, but each of its answers replaceable, to reach the store's faults. */
const through = (port: StatePort, over: Partial<Pick<StatePort, 'read' | 'stat'>>) => ({
  pathOf: port.pathOf.bind(port),
  read: over.read ?? port.read.bind(port),
  stat: over.stat ?? port.stat.bind(port),
});

describe('Skills’ installed store over the real state port', () => {
  test('lists the folders it holds with a regular SKILL.md, claims only its own path, and reads the text', async () => {
    const w = await world();
    await w.port.write(SKILLS_INSTALLED_STATE, 'x', 'dir/not-a-manifest.md');
    expect(await w.installed.entries(['inst', 'dir', 'absent', '../x', '.hidden'])).toEqual([
      { manifest: w.installed.manifestPath('inst'), managed: true },
    ]);
    const path = w.installed.manifestPath('inst');
    expect(w.installed.claims(path)).toBe(true);
    expect(w.installed.claims(path.replace('SKILL.md', 'other.md'))).toBe(false);
    expect(await w.installed.read(path, 1000)).toBe(doc('inst'));
    expect(await w.installed.read(path, 5)).toBeUndefined();
    expect(await w.installed.read(w.installed.manifestPath('absent'), 1000)).toBeUndefined();
    expect(await w.installed.read('/etc/passwd', 1000)).toBeUndefined();
  });

  test('a store that faults, or answers bytes, an absence or a refusal, reads nothing wrong', async () => {
    const w = await world();
    const path = w.installed.manifestPath('inst');
    const boom = async () => Promise.reject(new Error('boom'));
    expect(await new InstalledSkillFiles(through(w.port, { stat: boom })).entries(['inst'])).toEqual([]);
    expect(await new InstalledSkillFiles(through(w.port, { stat: boom })).read(path, 1000)).toBeUndefined();
    expect(await new InstalledSkillFiles(through(w.port, { read: boom })).read(path, 1000)).toBeUndefined();
    const refused = through(w.port, { read: (async () => ({ ok: false, error: 'refused' })) as never });
    expect(await new InstalledSkillFiles(refused).read(path, 1000)).toBeUndefined();
    const absent = through(w.port, { read: (async () => ok(undefined)) as never });
    expect(await new InstalledSkillFiles(absent).read(path, 1000)).toBeUndefined();
    const bytes = through(w.port, { read: (async () => ok(new TextEncoder().encode('from bytes'))) as never });
    expect(await new InstalledSkillFiles(bytes).read(path, 1000)).toBe('from bytes');
    const folder = through(w.port, { stat: (async () => ({ kind: 'directory' })) as never });
    expect(await new InstalledSkillFiles(folder).read(path, 1000)).toBeUndefined();
  });
});

describe('the skill file router over the real project and installed readers', () => {
  const skills = (w: Awaited<ReturnType<typeof world>>) => join(w.project, '.claude', 'skills');

  test('R-0197 sends each path to the one reader that owns it, and a path nobody owns is nothing', async () => {
    const w = await world();
    const router = w.router();
    expect((await router.list(`${w.fleetHome.home}/skills`, 10)).map(entry => entry.manifest)).toEqual([
      `${w.fleetHome.home}/skills/mine/SKILL.md`,
    ]);
    expect((await router.list(skills(w), 10)).map(entry => entry.manifest)).toEqual([`${skills(w)}/pp/SKILL.md`]);
    expect(await router.list('/etc', 10)).toEqual([]);
    expect(await router.read(w.installed.manifestPath('inst'), 1000)).toBe(doc('inst'));
    expect(await router.read(`${w.fleetHome.home}/skills/mine/SKILL.md`, 1000)).toBe('home text of mine');
    expect(await router.read(w.assetManifest, 1000)).toBe('asset text of tool');
    expect(await router.read(`${skills(w)}/pp/SKILL.md`, 1000)).toBe(doc('pp'));
    expect(await router.read('/etc/passwd', 1000)).toBeUndefined();
  });

  test('a home that is gone or whose reader fails, and an asset tree that fails or lists nothing of the path, read nothing', async () => {
    const w = await world();
    const mine = `${w.fleetHome.home}/skills/mine/SKILL.md`;
    const boom = async () => Promise.reject(new Error('boom'));
    expect(await w.router({ home: () => undefined }).list(`${w.fleetHome.home}/skills`, 10)).toEqual([]);
    const brokenHome = { skills: boom, skillManifest: boom } as unknown as RuntimeHomeReader;
    expect(await w.router({ home: () => brokenHome }).list(`${w.fleetHome.home}/skills`, 10)).toEqual([]);
    expect(await w.router({ home: () => brokenHome }).read(mine, 1000)).toBeUndefined();
    expect(await w.router({ home: () => undefined }).read(mine, 1000)).toBeUndefined();
    expect(await w.router({ assets: () => undefined }).read(w.assetManifest, 1000)).toBeUndefined();
    expect(await w.router().read(`${w.assetManifest}/../SKILL.md`, 1000)).toBeUndefined();
    expect(await w.router().read(w.assetManifest.replace('/tool/', '/planted/'), 1000)).toBeUndefined();
    const failing = { skills: boom, skillManifest: boom } as unknown as RuntimeAssetSkills;
    expect(await w.router({ assets: () => failing }).read(w.assetManifest, 1000)).toBeUndefined();
    const unread = { ...w.assets, skillManifest: boom } as unknown as RuntimeAssetSkills;
    expect(await w.router({ assets: () => unread }).read(w.assetManifest, 1000)).toBeUndefined();
  });

  test('R-0197 a ferret working in a folder that holds the Ferretry home still sees its home, asset and installed skills', async () => {
    const w = await world();
    // The ferret's `work` is the real imports root scoped to the whole temp parent (it holds the home, as the kernel allows).
    const files = new RootSkillFiles(w.roots.root('imports', { subfolder: w.parent }), w.parent);
    const router = w.router({ work: { files, base: w.parent } });
    expect((await router.list(`${w.fleetHome.home}/skills`, 10)).map(entry => entry.manifest)).toEqual([
      `${w.fleetHome.home}/skills/mine/SKILL.md`,
    ]);
    expect(await router.read(w.assetManifest, 1000)).toBe('asset text of tool');
    expect(await router.read(w.installed.manifestPath('inst'), 1000)).toBe(doc('inst'));
    // every other path of that folder goes to the work root
    expect((await router.list(skills(w), 10)).map(entry => entry.manifest)).toEqual([`${skills(w)}/pp/SKILL.md`]);
    expect(await router.read(`${skills(w)}/pp/SKILL.md`, 1000)).toBe(doc('pp'));
    expect(await router.read(join(w.project, 'nothing', 'SKILL.md'), 1000)).toBeUndefined();
  });
});
