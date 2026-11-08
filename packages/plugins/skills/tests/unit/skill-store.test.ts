/**
 * Skills' own installed store (`installed/<name>/`, the home of today's `<fleet>/assets/skills/<name>/`, F-0184) and
 * the shared folder it mints for a launch: written only through Skills' state port, shared only from there, and
 * linked into a ferret home by the harness side. Real state, real roots, a real disk.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeSkills } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
import { nodeFs } from '../../../../core/kernel/host/adapters/node-fs.ts';
import { ensureInternalRootBases, rootsPortFor } from '../../../../core/kernel/host/roots.ts';
import { SKILLS_INSTALLED_STATE } from '../../contract/index.ts';
import { skillParts } from '../../daemon/lib/launch-parts.ts';
import {
  installRefusal,
  InstalledSkillRefused,
  MAX_INSTALLED_FILE_BYTES,
  SkillStore,
  usableSkillName,
} from '../../daemon/lib/skill-store.ts';
import skillsDaemon from '../../daemon/index.ts';
import manifest from '../../manifest.ts';

const F1 = 'f1' as FerretId;
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function fixture() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-skill-store-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/state/skills`, { recursive: true, mode: 0o700 });
  const hostFs = state.createNodeHostFs();
  const port = state.createStatePort({ home, pluginId: 'skills', files: [SKILLS_INSTALLED_STATE], fs: hostFs });
  const fs = nodeFs(() => crypto.randomUUID());
  await ensureInternalRootBases(fs, { home, plugin: 'claude-code' }, ['agent-homes']);
  const shares: string[] = [];
  const skillsRoots = rootsPortFor(fs, { home, plugin: 'skills', worktrees: `${home}-w` }, [], () => undefined, {
    shareTrees: manifest.permissions?.shareTrees === true,
    stateFiles: manifest.data?.state ?? [],
    onStop: () => {},
  });
  const claude = rootsPortFor(
    fs,
    { home, plugin: 'claude-code', worktrees: `${home}-w` },
    ['agent-homes'],
    () => undefined,
  );
  const homes = claude.root('agent-homes');
  const at = homes.resolve(F1);
  if (!at.ok) throw new Error(at.error);
  await homes.ensurePrivateDirectory(at.value);
  const store = new SkillStore(port, {
    share: async source => {
      shares.push(`${source.state.name}/${source.name}`);
      return await skillsRoots.share(source);
    },
  });
  return {
    port,
    skillsRoots,
    store,
    shares,
    installed: `${home}/state/skills/installed`,
    ferretHome: claude.root('agent-homes', { ferret: F1, subfolder: F1 }),
    ferretDisk: `${home}/state/claude-code/agent-homes/${F1}`,
  };
}

const SKILL = [
  { path: 'SKILL.md', content: '---\nname: review\n---\nreview\n' },
  { path: 'scripts/run.sh', content: 'run\n' },
];

describe('F-0184 the installed store is Skills’ own state tree', () => {
  test('F-0184 install writes every file under installed/<name>/ through the state port, and replaces what was there', async () => {
    const f = await fixture();
    await f.store.install('review', SKILL);
    expect(await readFile(join(f.installed, 'review', 'scripts', 'run.sh'), 'utf8')).toBe('run\n');
    await f.store.install('review', [{ path: 'SKILL.md', content: 'v2\n' }]);
    expect(await readFile(join(f.installed, 'review', 'SKILL.md'), 'utf8')).toBe('v2\n');
    expect(
      await lstat(join(f.installed, 'review', 'scripts')).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test('F-0184 uninstall removes the folder, and a name that is no folder removes nothing', async () => {
    const f = await fixture();
    await f.store.install('review', SKILL);
    await f.store.uninstall('..');
    await f.store.uninstall('review');
    expect(await f.store.tree('review')).toBeUndefined();
  });

  test('F-0184 the manifest declares the tree and the permission to share it', () => {
    expect(manifest.data?.state).toContain(SKILLS_INSTALLED_STATE);
    expect(manifest.permissions?.shareTrees).toBe(true);
    expect(SKILLS_INSTALLED_STATE.store).toBe('opaque');
  });
});

describe('F-0184 a skill that cannot be one folder is refused before anything is written', () => {
  const bad: readonly (readonly [string, string, typeof SKILL])[] = [
    ['a name with a separator', 'a/b', SKILL],
    ['a parent name', '..', SKILL],
    ['a hidden name (never the harness’s .system)', '.system', SKILL],
    ['an empty name', '', SKILL],
    ['a path that climbs', 'ok', [...SKILL, { path: '../escape', content: 'x' }]],
    ['an absolute path', 'ok', [...SKILL, { path: '/etc/passwd', content: 'x' }]],
    ['a path with a dot segment', 'ok', [...SKILL, { path: './a', content: 'x' }]],
    ['a path given twice', 'ok', [...SKILL, SKILL[0] as (typeof SKILL)[number]]],
    ['no SKILL.md', 'ok', [{ path: 'README.md', content: 'x' }]],
    ['no files', 'ok', []],
    ['a file over the bound', 'ok', [...SKILL, { path: 'big.txt', content: 'x'.repeat(MAX_INSTALLED_FILE_BYTES + 1) }]],
  ];
  for (const [what, name, files] of bad)
    test(`F-0184 ${what}`, async () => {
      const f = await fixture();
      await f.store.install('good', SKILL);
      await expect(f.store.install(name, files)).rejects.toBeInstanceOf(InstalledSkillRefused);
      expect(installRefusal(name, files)).toBeDefined();
      // Refused means untouched: the skill that was there is still there.
      expect(await readFile(join(f.installed, 'good', 'SKILL.md'), 'utf8')).toBe(SKILL[0]?.content ?? '');
    });

  test('F-0184 usableSkillName takes one plain component only', () => {
    expect(['review', 'a.b-c_d', 'A1'].every(usableSkillName)).toBe(true);
    expect(['', '.x', 'a/b', 'a b', '..', 'a..b', 'x'.repeat(65)].some(usableSkillName)).toBe(false);
  });
});

describe('F-0184 only an installed folder is shared', () => {
  test('F-0184 tree shares exactly installed/<name> of its own state, nothing else', async () => {
    const f = await fixture();
    await f.store.install('review', SKILL);
    expect(await f.store.tree('review')).toBeDefined();
    expect(f.shares).toEqual(['installed/review']);
  });

  test('F-0184 a name the store lacks, a bad name, or a file at the name shares nothing', async () => {
    const f = await fixture();
    await mkdir(f.installed, { recursive: true });
    await writeFile(join(f.installed, 'afile'), 'x');
    expect(await f.store.tree('absent')).toBeUndefined();
    expect(await f.store.tree('../x')).toBeUndefined();
    expect(await f.store.tree('afile')).toBeUndefined();
    expect(f.shares).toEqual([]);
  });

  test('F-0184 end to end: installed, selected by an item, shared, and linked into a ferret home the harness reads', async () => {
    const f = await fixture();
    await f.store.install('review', SKILL);
    const parts = await skillParts(new Map([['mine', { items: ['review', 'not-installed'] }]]), 'claude-code', name =>
      f.store.tree(name),
    );
    expect(parts.map(part => part.kind === 'skill' && part.name)).toEqual(['review']);
    const made = await materializeSkills(f.ferretHome, parts, []);
    expect(made.linked).toEqual(['review']);
    const at = join(f.ferretDisk, 'skills', 'review');
    expect((await lstat(at)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(at, 'SKILL.md'), 'utf8')).toBe(SKILL[0]?.content ?? '');
  });
});

describe('F-0184 the daemon half hands a launch the installed skills it selects', () => {
  test('F-0184 launch.parts yields one shared skill part per installed folder an item names, for the launching harness', async () => {
    const f = await fixture();
    await f.store.install('review', SKILL);
    const items = new Map([['mine', { items: ['review', 'not-installed'], harness: 'claude-code' }]]);
    const half = skillsDaemon.build?.({
      kernel: { state: f.port, roots: f.skillsRoots, config: { collection: () => items } },
      needs: { ferrets: { get: async () => undefined } },
    } as never);
    const taker = (
      (half as unknown as { hooks: Record<string, unknown> }).hooks['launch.parts'] as unknown as () => readonly {
        item: { parts(spec: unknown): Promise<readonly { kind: string; name: string; tree?: unknown }[]> };
      }[]
    )();
    const parts = await taker[0]?.item.parts({ harness: 'claude-code' });
    expect(parts?.map(part => part.name)).toEqual(['review']);
    expect(parts?.[0]?.tree).toBeDefined();
    expect(await taker[0]?.item.parts({ harness: 'codex' })).toEqual([]);
  });
});
