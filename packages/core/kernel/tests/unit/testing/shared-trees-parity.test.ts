/**
 * The testing host's shared trees stay in step with the real roots port: the same rules (`host/shared-trees.ts`) decide
 * who may mint, from what, into what, and when a link is made instead of a copy, so a plugin's unit test meets the
 * refusals and the link-or-copy answers production gives, under BOTH link rules.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/define.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { KernelPorts, RootHandle, RootName, SharedTree } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import { SharedTreeError, type SharedTreeLinkRule } from '../../../host/shared-trees.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import type { Manifest } from '../../../manifest/types.ts';
import { testHost } from '../../../testing/index.ts';

const INSTALLED = defineState({ name: 'installed', path: 'installed/*', store: 'opaque', format: 1 });
const OTHER = defineState({ name: 'other', path: 'other/*', store: 'opaque', format: 1 });
const F1 = 'f1' as FerretId;
const F2 = 'f2' as FerretId;
const SKILLS_ROOTS: readonly RootName[] = ['work', 'imports', 'downloads'];
const CLAUDE_ROOTS: readonly RootName[] = ['agent-homes', 'work'];

const skillsManifest = definePlugin({
  id: 'skills',
  title: 'Skills',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  permissions: { roots: [...SKILLS_ROOTS], shareTrees: true },
  data: { state: [INSTALLED] },
});
const claudeManifest = definePlugin({
  id: 'claude-code',
  title: 'Claude Code',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  permissions: { roots: [...CLAUDE_ROOTS] },
});

/** One host, as a case sees it: the minter's and the receiver's roots, the files a destination holds, and stop. */
interface Side {
  readonly skills: KernelPorts['roots'];
  readonly claude: KernelPorts['roots'];
  files(home: RootHandle, to: FencedPath): Promise<readonly string[]>;
  stop(): Promise<void> | void;
}

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

async function walk(folder: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const full = join(folder, entry.name);
    const inner = await readdir(full).then(
      () => true,
      () => false,
    );
    if (inner) out.push(...(await walk(full, name)));
    else out.push(name);
  }
  return out.toSorted();
}

async function real(rule: SharedTreeLinkRule): Promise<Side> {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-shared-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const project = `${parent}/project`;
  await mkdir(`${home}/state/skills/installed/abc/scripts`, { recursive: true, mode: 0o700 });
  await writeFile(`${home}/state/skills/installed/abc/SKILL.md`, 'installed\n');
  await writeFile(`${home}/state/skills/installed/abc/scripts/run.sh`, 'run\n');
  await mkdir(`${project}/.claude/skills/local`, { recursive: true });
  await writeFile(`${project}/.claude/skills/local/SKILL.md`, 'project\n');
  const fs = nodeFs(() => crypto.randomUUID());
  await ensureInternalRootBases(fs, { home, plugin: 'claude-code' }, ['agent-homes']);
  await ensureInternalRootBases(fs, { home, plugin: 'skills' }, ['downloads']);
  const workFolders: WorkFolders = {
    folderOf: () => project as FencedPath,
    check: (_ferret, path) => (path.startsWith(project) ? ok(path as FencedPath) : err('outside')),
  };
  const stops: (() => void)[] = [];
  const port = (manifest: Manifest) =>
    rootsPortFor(
      fs,
      { home, plugin: manifest.id, worktrees: `${home}-worktrees` },
      manifest.permissions?.roots ?? [],
      () => workFolders,
      {
        shareTrees: manifest.permissions?.shareTrees === true,
        stateFiles: manifest.data?.state ?? [],
        onStop: fn => stops.push(fn),
        linkRule: rule,
      },
    );
  const skills = port(skillsManifest);
  const claude = port(claudeManifest);
  return {
    skills,
    claude,
    files: async (_home, to) => await walk(to),
    stop: () => {
      for (const fn of stops.splice(0)) fn();
    },
  };
}

async function testing(rule: SharedTreeLinkRule): Promise<Side> {
  let skills: KernelPorts['roots'] | undefined;
  let claude: KernelPorts['roots'] | undefined;
  const skillsHalf = implementDaemon(skillsManifest, {
    build: ctx => {
      skills = ctx.kernel.roots;
      return {};
    },
  });
  const claudeHalf = implementDaemon(claudeManifest, {
    build: ctx => {
      claude = ctx.kernel.roots;
      return {};
    },
  });
  const host = await testHost({ plugins: [skillsHalf, claudeHalf], sharedTreeLinks: rule });
  const encoder = new TextEncoder();
  host.state('skills').plantBytes(INSTALLED, encoder.encode('installed\n'), 'abc/SKILL.md');
  host.state('skills').plantBytes(INSTALLED, encoder.encode('run\n'), 'abc/scripts/run.sh');
  host.putRoot('work', '.claude/skills/local/SKILL.md', 'project\n');
  if (skills === undefined || claude === undefined) throw new Error('the halves were not built');
  return {
    skills,
    claude,
    files: async (home, to) => (await home.list(to)).toSorted(),
    stop: () => host.stop(),
  };
}

const resolved = (root: RootHandle, path: string): FencedPath => {
  const answer = root.resolve(path);
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};

/** What a case came to: the shared-tree refusal, `refused` for a root refusal, or the answer and the files made. */
async function outcome(side: Side, home: RootHandle, act: () => Promise<{ to: FencedPath; made: string }>) {
  try {
    const { to, made } = await act();
    return { made, files: await side.files(home, to) };
  } catch (error) {
    if (error instanceof SharedTreeError) return { refused: error.refusal };
    if (error instanceof RootError || error instanceof Error) return { refused: 'root' };
    throw error;
  }
}

type Case = (side: Side) => Promise<unknown>;

const projectTree = async (side: Side): Promise<SharedTree> => {
  const work = side.skills.root('work', { ferret: F1 });
  return await side.skills.share({ root: work, path: resolved(work, '.claude/skills/local') });
};
const homeOf = (side: Side, ferret: FerretId): RootHandle =>
  side.claude.root('agent-homes', { ferret, subfolder: ferret });
const into =
  (side: Side, ferret: FerretId, tree: () => Promise<SharedTree>, name: string, link?: boolean) =>
  async (): Promise<{ to: FencedPath; made: string }> => {
    const home = homeOf(side, ferret);
    const to = resolved(home, `skills/${name}`);
    return { to, made: await home.copyShared(await tree(), to, link === undefined ? undefined : { link }) };
  };

const CASES: Readonly<Record<string, Case>> = {
  'project skill, copy': async side =>
    await outcome(
      side,
      homeOf(side, F1),
      into(side, F1, () => projectTree(side), 'p'),
    ),
  'project skill, link asked': async side =>
    await outcome(
      side,
      homeOf(side, F1),
      into(side, F1, () => projectTree(side), 'p', true),
    ),
  'project skill, link asked into another ferret’s home': async side =>
    await outcome(
      side,
      homeOf(side, F2),
      into(side, F2, () => projectTree(side), 'p', true),
    ),
  'installed skill, copy': async side =>
    await outcome(
      side,
      homeOf(side, F1),
      into(side, F1, () => side.skills.share({ state: INSTALLED, name: 'abc' }), 'abc'),
    ),
  'installed skill, link asked': async side => {
    const result = await outcome(
      side,
      homeOf(side, F1),
      into(side, F1, () => side.skills.share({ state: INSTALLED, name: 'abc' }), 'abc', true),
    );
    return result;
  },
  'not permitted: a receiver mints': async side => {
    const work = side.claude.root('work', { ferret: F1 });
    return await outcome(
      side,
      homeOf(side, F1),
      into(side, F1, () => side.claude.share({ root: work, path: resolved(work, '.claude/skills/local') }), 'x'),
    );
  },
  'not own: another plugin’s handle': async side => {
    const theirs = side.claude.root('work', { ferret: F1 });
    return await outcome(
      side,
      homeOf(side, F1),
      into(side, F1, () => side.skills.share({ root: theirs, path: resolved(theirs, '.claude/skills/local') }), 'x'),
    );
  },
  'not own: an undeclared named tree': async side =>
    await outcome(
      side,
      homeOf(side, F1),
      into(side, F1, () => side.skills.share({ state: OTHER, name: 'abc' }), 'x'),
    ),
  'not own: a bad name': async side =>
    await outcome(
      side,
      homeOf(side, F1),
      into(side, F1, () => side.skills.share({ state: INSTALLED, name: '../x' }), 'x'),
    ),
  'not shareable: downloads': async side => {
    const downloads = side.skills.root('downloads');
    return await outcome(
      side,
      homeOf(side, F1),
      into(side, F1, () => side.skills.share({ root: downloads, path: resolved(downloads, 'x') }), 'x'),
    );
  },
  'not shared: forged': async side =>
    await outcome(
      side,
      homeOf(side, F1),
      into(side, F1, async () => ({}) as SharedTree, 'x'),
    ),
  'not shared: a JSON round trip': async side =>
    await outcome(
      side,
      homeOf(side, F1),
      into(side, F1, async () => JSON.parse(JSON.stringify(await projectTree(side))) as SharedTree, 'x'),
    ),
  'not internal: a work destination': async side => {
    const work = side.claude.root('work', { ferret: F1 });
    return await outcome(side, work, async () => {
      const to = resolved(work, 'copied');
      return { to, made: await work.copyShared(await projectTree(side), to) };
    });
  },
  'revoked: the minter stopped': async side => {
    const tree = await projectTree(side);
    await side.stop();
    return await outcome(
      side,
      homeOf(side, F1),
      into(side, F1, async () => tree, 'late'),
    );
  },
};

for (const rule of ['link-internal', 'link-own'] as const)
  for (const [name, run] of Object.entries(CASES))
    test(`parity (${rule}): ${name}`, async () => {
      const onReal = await run(await real(rule));
      const onTesting = await run(await testing(rule));
      expect(onTesting).toEqual(onReal);
    });

test('the cases cover each answer under each rule (the parity is not vacuous)', async () => {
  const internal = await real('link-internal');
  expect(await CASES['project skill, link asked']?.(internal)).toEqual({ made: 'copied', files: ['SKILL.md'] });
  expect(await CASES['installed skill, link asked']?.(internal)).toEqual({
    made: 'linked',
    files: ['SKILL.md', 'scripts/run.sh'],
  });
  const own = await real('link-own');
  expect(await CASES['project skill, link asked']?.(own)).toEqual({ made: 'linked', files: ['SKILL.md'] });
  expect(await CASES['project skill, link asked into another ferret’s home']?.(own)).toEqual({
    made: 'copied',
    files: ['SKILL.md'],
  });
  for (const [name, refusal] of [
    ['not permitted: a receiver mints', 'not_permitted'],
    ['not own: another plugin’s handle', 'not_own'],
    ['not own: an undeclared named tree', 'not_own'],
    ['not own: a bad name', 'not_own'],
    ['not shareable: downloads', 'not_shareable'],
    ['not shared: forged', 'not_shared'],
    ['not shared: a JSON round trip', 'not_shared'],
    ['not internal: a work destination', 'not_internal'],
    ['revoked: the minter stopped', 'not_shared'],
  ] as const)
    expect(await CASES[name]?.(await real('link-internal'))).toEqual({ refused: refusal });
});
