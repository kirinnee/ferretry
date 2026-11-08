/**
 * The harness side of the one skill link rule (kernel batch #10, ruling #52 Q2 + Q5, owner decision !A466): a launch's
 * selected skills reach the ferret home as ONE link each to the folder Skills shared, a deselected one leaves, and a
 * skill that was not shared (a project's) is neither copied nor linked. Real roots on a real disk, the minter and the
 * receiver two plugins of one home, as the host runs them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineState } from '@ferretry/kernel/contract';
import type { FencedPath, FerretId, RootHandle, SharedTree } from '@ferretry/kernel/contract';
import { nodeFs } from '../../../kernel/host/adapters/node-fs.ts';
import { ensureInternalRootBases, rootsPortFor } from '../../../kernel/host/roots.ts';
import { materializeSkills } from '../../contract/skill-home.ts';
import type { LaunchPart } from '../../contract/kinds.ts';

const INSTALLED = defineState({ name: 'installed', path: 'installed/*', store: 'opaque', format: 1 });
const F1 = 'f1' as FerretId;

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

function resolved(root: RootHandle, path: string): FencedPath {
  const answer = root.resolve(path);
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
}

async function fixture() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-skill-home-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const installed = `${home}/state/skills/installed`;
  await mkdir(`${installed}/review/scripts`, { recursive: true, mode: 0o700 });
  await writeFile(`${installed}/review/SKILL.md`, 'review\n');
  await writeFile(`${installed}/review/scripts/run.sh`, 'run\n');
  await mkdir(`${installed}/lint`, { recursive: true, mode: 0o700 });
  await writeFile(`${installed}/lint/SKILL.md`, 'lint\n');
  const fs = nodeFs(() => crypto.randomUUID());
  await ensureInternalRootBases(fs, { home, plugin: 'claude-code' }, ['agent-homes']);
  const stops: (() => void)[] = [];
  const skills = rootsPortFor(fs, { home, plugin: 'skills', worktrees: `${home}-worktrees` }, [], () => undefined, {
    shareTrees: true,
    stateFiles: [INSTALLED],
    onStop: fn => stops.push(fn),
  });
  const claude = rootsPortFor(
    fs,
    { home, plugin: 'claude-code', worktrees: `${home}-worktrees` },
    ['agent-homes'],
    () => undefined,
  );
  const homes = claude.root('agent-homes');
  await homes.ensurePrivateDirectory(resolved(homes, F1));
  return {
    home: claude.root('agent-homes', { ferret: F1, subfolder: F1 }),
    disk: `${home}/state/claude-code/agent-homes/${F1}`,
    installed,
    tree: async (name: string): Promise<SharedTree> => await skills.share({ state: INSTALLED, name }),
    stop: () => {
      for (const fn of stops.splice(0)) fn();
    },
  };
}

const part = (name: string, tree?: SharedTree): LaunchPart =>
  tree === undefined ? { kind: 'skill', name } : { kind: 'skill', name, tree };

const gone = async (path: string): Promise<boolean> =>
  await lstat(path).then(
    () => false,
    () => true,
  );

describe('F-0006 the selected skills are linked into the ferret home, one link each', () => {
  test('F-0006 a shared skill is ONE link to the minter’s installed folder, and the harness reads it through the link', async () => {
    const f = await fixture();
    const made = await materializeSkills(f.home, [part('review', await f.tree('review'))], []);
    expect(made).toEqual({ linked: ['review'], copied: [], skipped: [], pruned: [], kept: [], stuck: [] });
    const at = join(f.disk, 'skills', 'review');
    expect((await lstat(at)).isSymbolicLink()).toBe(true);
    expect(await realpath(at)).toBe(join(f.installed, 'review'));
    expect(await readFile(join(at, 'scripts', 'run.sh'), 'utf8')).toBe('run\n');
  });

  test('F-0006 a relaunch finds last time’s link, leaves it as it is and keeps the skill', async () => {
    const f = await fixture();
    await materializeSkills(f.home, [part('review', await f.tree('review'))], []);
    const again = await materializeSkills(f.home, [part('review', await f.tree('review'))], []);
    expect(again.kept).toEqual(['review']);
    expect(again.linked).toEqual([]);
    expect(await readFile(join(f.disk, 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('review\n');
  });

  test('F-0006 a deselected skill leaves the home; a harness-owned folder stays; what the minter holds is never touched', async () => {
    const f = await fixture();
    await materializeSkills(
      f.home,
      [part('review', await f.tree('review')), part('lint', await f.tree('lint'))],
      ['.system'],
    );
    await mkdir(join(f.disk, 'skills', '.system'), { recursive: true });
    await writeFile(join(f.disk, 'skills', '.system', 'bundled.md'), 'codex\n');
    await mkdir(join(f.disk, 'skills', 'stale'), { recursive: true });
    await writeFile(join(f.disk, 'skills', 'stale', 'SKILL.md'), 'old\n');
    const made = await materializeSkills(f.home, [part('review', await f.tree('review'))], ['.system']);
    // A folder goes; a link cannot be unlinked by the root (declared GAP), so it is reported and stays.
    expect(made.pruned).toEqual(['stale']);
    expect(made.stuck).toEqual(['lint']);
    expect(await readFile(join(f.disk, 'skills', '.system', 'bundled.md'), 'utf8')).toBe('codex\n');
    expect((await lstat(join(f.disk, 'skills', 'lint'))).isSymbolicLink()).toBe(true);
    // Whatever happens to the link, what it points at is never touched.
    expect(await readFile(join(f.installed, 'lint', 'SKILL.md'), 'utf8')).toBe('lint\n');
  });

  test('F-0006 a project skill (a part with no shared folder) is neither copied nor linked', async () => {
    const f = await fixture();
    const project: LaunchPart = { kind: 'skill', name: 'local', path: '/work/app/.claude/skills/local' as FencedPath };
    const made = await materializeSkills(f.home, [project], []);
    expect(made).toEqual({ linked: [], copied: [], skipped: ['local'], pruned: [], kept: [], stuck: [] });
    expect(await gone(join(f.disk, 'skills', 'local'))).toBe(true);
  });

  test('F-0006 a name that is not one plain folder, or is the harness’s own, makes nothing', async () => {
    const f = await fixture();
    const tree = await f.tree('review');
    const names = ['../escape', 'a/b', '.hidden', '.system', '', 'x y'];
    const made = await materializeSkills(
      f.home,
      names.map(name => part(name, tree)),
      ['.system'],
    );
    expect(made.skipped).toEqual(names);
    expect(made.linked).toEqual([]);
    expect(await gone(join(f.disk, 'escape'))).toBe(true);
  });

  test('F-0006 a folder the harness owns is never claimed by a skill of that name', async () => {
    const f = await fixture();
    await mkdir(join(f.disk, 'skills', 'bundled'), { recursive: true });
    await writeFile(join(f.disk, 'skills', 'bundled', 'own.md'), 'harness\n');
    const made = await materializeSkills(f.home, [part('bundled', await f.tree('review'))], ['bundled']);
    expect(made.skipped).toEqual(['bundled']);
    expect(await readFile(join(f.disk, 'skills', 'bundled', 'own.md'), 'utf8')).toBe('harness\n');
  });

  test('F-0006 a name two items select is made once, by the first part', async () => {
    const f = await fixture();
    const made = await materializeSkills(
      f.home,
      [part('review', await f.tree('review')), part('review', await f.tree('lint'))],
      [],
    );
    expect(made.linked).toEqual(['review']);
    expect(await readFile(join(f.disk, 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('review\n');
  });

  test('F-0006 a forged tree is refused and leaves nothing in the home', async () => {
    const f = await fixture();
    const forged = { shared: 'review' } as unknown as SharedTree;
    await expect(materializeSkills(f.home, [part('review', forged)], [])).rejects.toThrow();
    expect(await gone(join(f.disk, 'skills', 'review'))).toBe(true);
  });

  test('F-0006 a tree whose minter stopped is refused', async () => {
    const f = await fixture();
    const tree = await f.tree('review');
    f.stop();
    await expect(materializeSkills(f.home, [part('review', tree)], [])).rejects.toThrow();
  });

  test('F-0006 a link already at skills/ is never followed, and what it names is never touched', async () => {
    const f = await fixture();
    await mkdir(join(f.disk, 'skills'), { recursive: true });
    await mkdir(join(f.disk, '..', 'victim'), { recursive: true });
    await writeFile(join(f.disk, '..', 'victim', 'keep.txt'), 'keep\n');
    await symlink(join(f.disk, '..', 'victim'), join(f.disk, 'skills', 'review'));
    const made = await materializeSkills(f.home, [part('review', await f.tree('review'))], []);
    expect(made.kept).toEqual(['review']);
    expect(await readFile(join(f.disk, '..', 'victim', 'keep.txt'), 'utf8')).toBe('keep\n');
  });
});

describe('F-0006 the answer says what was made', () => {
  test('F-0006 a copy where the kernel did not link is reported as copied, and a link was asked for', async () => {
    const calls: string[] = [];
    const home = {
      resolve: (relative: string) => ({ ok: true, value: `/h/${relative}` }),
      makeDirectory: async () => {},
      list: async () => [],
      remove: async () => {},
      copyShared: async (_tree: unknown, to: string, options?: { link?: boolean }) => {
        calls.push(`${to}:${String(options?.link)}`);
        return 'copied';
      },
    } as unknown as RootHandle;
    const made = await materializeSkills(home, [part('review', {} as SharedTree)], []);
    expect(made.copied).toEqual(['review']);
    expect(made.linked).toEqual([]);
    expect(calls).toEqual(['/h/skills/review:true']);
  });
});
