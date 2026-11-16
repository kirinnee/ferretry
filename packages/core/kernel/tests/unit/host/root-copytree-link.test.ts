/**
 * BG-004 (X1): `copyTree {link:true}` is not a second way round `linkTo`'s rules (§7.7). A link is written only INTO a
 * root that takes links (`fleet`, `agent-homes`) and never FROM an owner's root (`work`, `imports`, `harness-home`,
 * `harness-history`, `project-files`). Each root kind has its own case on the real disk; a refused call plants nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { RootHandle, RootName } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const DECLARED: readonly RootName[] = [
  'fleet',
  'agent-homes',
  'downloads',
  'worktrees',
  'work',
  'imports',
  'harness-home',
  'harness-history',
  'project-files',
];

const at = (root: RootHandle, path: string): FencedPath => {
  const resolved = root.resolve(path);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

async function refusalOf(call: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await call();
    return undefined;
  } catch (error) {
    if (error instanceof RootError) return error.refusal;
    throw error;
  }
}

const exists = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined)) !== undefined;

/** One plugin ('runtimes', which may hold `fleet` and `harness-home`) holding every root kind, each with a `pack` folder. */
async function fresh() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/root-copytree-link-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const work = `${parent}/work`;
  const imports = `${parent}/imports`;
  const harness = `${parent}/harness`;
  const history = `${parent}/history`;
  const proj = `${parent}/proj`;
  for (const folder of [`${home}/state`, `${home}/config`, `${home}-worktrees`, work, imports, harness, history, proj])
    await mkdir(folder, { recursive: true, mode: 0o700 });
  for (const folder of [work, imports, harness, history]) {
    await mkdir(`${folder}/pack`);
    await writeFile(`${folder}/pack/SKILL.md`, '# pack');
  }
  const disk = nodeFs(() => crypto.randomUUID());
  const workFolders: WorkFolders = {
    folderOf: () => work as FencedPath,
    check: (_ferret, path) => (path.startsWith(work) ? ok(path as FencedPath) : err('outside')),
  };
  await ensureInternalRootBases(disk, { home, plugin: 'runtimes' }, DECLARED);
  const roots = rootsPortFor(
    disk,
    { home, plugin: 'runtimes', worktrees: `${home}-worktrees` },
    DECLARED,
    () => workFolders,
    { random: () => 'rnd', projectFiles: ['.claude/skills/*/**'] },
  );
  const handles = {
    fleet: roots.root('fleet'),
    'agent-homes': roots.root('agent-homes'),
    downloads: roots.root('downloads'),
    worktrees: roots.root('worktrees'),
    work: roots.root('work', { ferret: 'F1' as FerretId }),
    imports: roots.root('imports', { subfolder: imports }),
    'harness-home': roots.root('harness-home', { subfolder: harness }),
    'harness-history': roots.root('harness-history', { subfolder: history }),
    'project-files': roots.root('project-files', { subfolder: proj }),
  } as const;
  await handles.downloads.makeDirectory(at(handles.downloads, 'pack'));
  await handles.downloads.writeText(at(handles.downloads, 'pack/SKILL.md'), '# pack');
  await handles.worktrees.makeDirectory(at(handles.worktrees, 'pack'));
  await handles.worktrees.writeText(at(handles.worktrees, 'pack/SKILL.md'), '# pack');
  await handles['project-files'].writeText(at(handles['project-files'], '.claude/skills/pack/SKILL.md'), '# pack');
  return { parent, home, work, handles };
}

/** The folder a source handle copies from. */
const sourceOf = (handles: Awaited<ReturnType<typeof fresh>>['handles'], kind: keyof typeof handles) =>
  at(handles[kind], kind === 'project-files' ? '.claude/skills/pack' : 'pack');

describe('BG-004 X1 copyTree {link:true} INTO a root', () => {
  test('BG-004 X1 into a writable root that takes no links (work, downloads, worktrees, project-files) is refused read_only: nothing is planted', async () => {
    const f = await fresh();
    for (const kind of ['work', 'downloads', 'worktrees'] as const) {
      const into = f.handles[kind];
      const to = at(into, 'planted');
      // the source is an internal root that is NOT an owner's: only the destination can be what refuses
      const source = kind === 'downloads' ? f.handles.worktrees : f.handles.downloads;
      expect(await refusalOf(() => into.copyTree(source, at(source, 'pack'), to, { link: true }))).toBe('read_only');
      expect(await refusalOf(() => into.copyTree(source, at(source, 'pack'), to, { link: true, maxEntries: 5 }))).toBe(
        'read_only',
      );
    }
    expect(await exists(`${f.work}/planted`)).toBe(false);
    expect(await exists(`${f.home}/state/runtimes/downloads/planted`)).toBe(false);
    expect(await exists(`${f.home}-worktrees/planted`)).toBe(false);
    // the same call as a COPY still works: the door left is real files in a new folder
    await f.handles.work.copyTree(f.handles.downloads, at(f.handles.downloads, 'pack'), at(f.handles.work, 'copied'));
    expect((await lstat(`${f.work}/copied`)).isSymbolicLink()).toBe(false);
    expect(await readFile(`${f.work}/copied/SKILL.md`, 'utf8')).toBe('# pack');
  });

  test('BG-004 X1 into a project folder is refused read_only, and nothing is made', async () => {
    const f = await fresh();
    const project = f.handles['project-files'];
    expect(
      await refusalOf(() =>
        project.copyTree(f.handles.downloads, at(f.handles.downloads, 'pack'), at(project, '.claude/skills/linked'), {
          link: true,
        }),
      ),
    ).toBe('read_only');
  });

  test('BG-004 X1 into a read-only owner root (imports, harness-home, harness-history) is refused read_only', async () => {
    const f = await fresh();
    for (const kind of ['imports', 'harness-home', 'harness-history'] as const) {
      const into = f.handles[kind];
      expect(
        await refusalOf(() =>
          into.copyTree(f.handles.downloads, at(f.handles.downloads, 'pack'), at(into, 'planted'), { link: true }),
        ),
      ).toBe('read_only');
    }
  });

  test('BG-004 X1 into fleet still makes a link to the REAL path of the source folder (the positive control)', async () => {
    const f = await fresh();
    const into = f.handles.fleet;
    await into.copyTree(f.handles.downloads, at(f.handles.downloads, 'pack'), at(into, 'linked'), { link: true });
    const planted = `${f.home}/fleet/linked`;
    expect((await lstat(planted)).isSymbolicLink()).toBe(true);
    expect(await readlink(planted)).toBe(`${f.home}/state/runtimes/downloads/pack`);
  });

  test('into agent-homes (a credential home) the link is refused link_escape and nothing is planted', async () => {
    const f = await fresh();
    const into = f.handles['agent-homes'];
    expect(
      await refusalOf(() =>
        into.copyTree(f.handles.downloads, at(f.handles.downloads, 'pack'), at(into, 'linked'), { link: true }),
      ),
    ).toBe('link_escape');
    await expect(lstat(`${f.home}/state/runtimes/agent-homes/linked`)).rejects.toThrow();
  });
});

describe('BG-004 X1 copyTree {link:true} FROM a root', () => {
  test('BG-004 X1 from an owner root (work, imports, harness-home, harness-history, project-files) into fleet or agent-homes is refused not_declared: nothing is planted', async () => {
    const f = await fresh();
    for (const kind of ['work', 'imports', 'harness-home', 'harness-history', 'project-files'] as const) {
      for (const target of ['fleet', 'agent-homes'] as const) {
        const into = f.handles[target];
        const source = f.handles[kind];
        expect(
          await refusalOf(() => into.copyTree(source, sourceOf(f.handles, kind), at(into, kind), { link: true })),
        ).toBe('not_declared');
      }
    }
    for (const kind of ['work', 'imports', 'harness-home', 'harness-history', 'project-files'])
      for (const place of [`${f.home}/fleet/${kind}`, `${f.home}/state/runtimes/agent-homes/${kind}`])
        expect(await exists(place)).toBe(false);
  });

  test('BG-004 X1 from an owner root the same call as a COPY works: the door left is real files', async () => {
    const f = await fresh();
    for (const kind of ['work', 'imports', 'harness-home', 'harness-history', 'project-files'] as const) {
      const into = f.handles.fleet;
      await into.copyTree(f.handles[kind], sourceOf(f.handles, kind), at(into, `copy-${kind}`));
      expect((await lstat(`${f.home}/fleet/copy-${kind}`)).isSymbolicLink()).toBe(false);
      expect(await readFile(`${f.home}/fleet/copy-${kind}/SKILL.md`, 'utf8')).toBe('# pack');
    }
  });

  test('BG-004 X1 from an internal root that is not an owner root (downloads, worktrees) into fleet is a link', async () => {
    const f = await fresh();
    for (const kind of ['downloads', 'worktrees'] as const) {
      const into = f.handles.fleet;
      await into.copyTree(f.handles[kind], sourceOf(f.handles, kind), at(into, `link-${kind}`), { link: true });
      expect((await lstat(`${f.home}/fleet/link-${kind}`)).isSymbolicLink()).toBe(true);
    }
  });
});
