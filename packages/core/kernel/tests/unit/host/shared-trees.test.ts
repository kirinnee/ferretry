/**
 * Shared trees (kernel batch #10, rulings #52 Q2 + Q5): `RootsPort.share` mints ONE folder of the minter's own, and
 * `RootHandle.copyShared` materializes it in the receiver's internal root, on the real roots port and a real disk.
 * Who may mint, from what, into what, when a link is made, and that a forged, rebuilt or revoked tree opens nothing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import { defineState } from '../../../contract/define.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { RootHandle, RootName, RootsPort, SharedTree } from '../../../contract/ports.ts';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { ensureInternalRootBases, RootError, rootsPortFor } from '../../../host/roots.ts';
import {
  type SharedOrigin,
  SHARED_TREE_LINK_RULE,
  SharedTreeError,
  type SharedTreeLinkRule,
  sharedLinkAllowed,
} from '../../../host/shared-trees.ts';

const INSTALLED = defineState({ name: 'installed', path: 'installed/*', store: 'opaque', format: 1 });
const INSTALLS = defineState({ name: 'installs', path: 'installs.json', store: 'json', format: 1 });
const F1 = 'f1' as FerretId;
const F2 = 'f2' as FerretId;

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const fs = nodeFs(() => crypto.randomUUID());

/** A home, a project outside it (ferret f1's work folder), and Skills' installed skill `abc`. */
async function world(options: { readonly linkRule?: SharedTreeLinkRule; readonly shareTrees?: boolean } = {}) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-shared-trees-`));
  parents.push(parent);
  const home = `${parent}/home`;
  const project = `${parent}/project`;
  await mkdir(`${home}/state/skills/installed/abc/scripts`, { recursive: true, mode: 0o700 });
  await writeFile(`${home}/state/skills/installed/abc/SKILL.md`, 'installed skill\n');
  await writeFile(`${home}/state/skills/installed/abc/scripts/run.sh`, '#!/bin/sh\n', { mode: 0o755 });
  await mkdir(`${project}/.claude/skills/local`, { recursive: true });
  await writeFile(`${project}/.claude/skills/local/SKILL.md`, 'project skill\n');
  await ensureInternalRootBases(fs, { home, plugin: 'claude-code' }, ['agent-homes']);
  const folders = new Map<string, string>([[F1, project]]);
  const workFolders: WorkFolders = {
    folderOf: ferret => folders.get(ferret) as FencedPath | undefined,
    check: (ferret, path) => {
      const folder = folders.get(ferret);
      return folder !== undefined && (path === folder || path.startsWith(`${folder}/`))
        ? ok(path as FencedPath)
        : err('outside');
    },
  };
  const stops: (() => void)[] = [];
  const port = (plugin: string, declared: readonly RootName[], share: boolean): RootsPort =>
    rootsPortFor(fs, { home, plugin, worktrees: `${home}-worktrees` }, declared, () => workFolders, {
      shareTrees: share,
      stateFiles: [INSTALLED, INSTALLS],
      onStop: fn => stops.push(fn),
      ...(options.linkRule === undefined ? {} : { linkRule: options.linkRule }),
    });
  const skills = port('skills', ['work', 'imports'], options.shareTrees ?? true);
  const claude = port('claude-code', ['agent-homes', 'work'], false);
  return {
    parent,
    home,
    project,
    folders,
    skills,
    claude,
    stopSkills: () => {
      for (const fn of stops.splice(0)) fn();
    },
    /** Ferret `ferret`'s own home, as Claude Code scopes it. */
    homeOf: (ferret: FerretId, subfolder: string = ferret): RootHandle =>
      claude.root('agent-homes', { ferret, subfolder }),
    installedPath: `${home}/state/skills/installed/abc`,
  };
}

const resolved = (root: RootHandle, path: string): FencedPath => {
  const answer = root.resolve(path);
  if (!answer.ok) throw new Error(answer.error);
  return answer.value;
};

const projectSkill = async (w: Awaited<ReturnType<typeof world>>, ferret: FerretId = F1): Promise<SharedTree> => {
  const work = w.skills.root('work', { ferret });
  return await w.skills.share({ root: work, path: resolved(work, '.claude/skills/local') });
};

const refusalOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'none';
  } catch (error) {
    if (error instanceof SharedTreeError) return error.refusal;
    if (error instanceof RootError) return `root:${error.refusal}`;
    throw error;
  }
};

describe('sharedLinkAllowed: the one link rule', () => {
  const state: SharedOrigin = { kind: 'state' };
  const ownWork: SharedOrigin = { kind: 'root', root: 'work', ferret: F1 };
  const home = { root: 'agent-homes' as const, ferret: F1, subfolder: 'f1' };

  test('the default is link-internal: the #52 rule until the owner answers', () => {
    expect(SHARED_TREE_LINK_RULE).toBe('link-internal');
  });

  test('link-internal links a tree from the minter’s own state and copies every owner’s-root tree', () => {
    expect(sharedLinkAllowed('link-internal', state, home)).toBe(true);
    expect(sharedLinkAllowed('link-internal', ownWork, home)).toBe(false);
    expect(sharedLinkAllowed('link-internal', { kind: 'root', root: 'imports' }, home)).toBe(false);
  });

  test('link-own also links the receiving ferret’s OWN work folder into its OWN home, and nothing else', () => {
    expect(sharedLinkAllowed('link-own', state, home)).toBe(true);
    expect(sharedLinkAllowed('link-own', ownWork, home)).toBe(true);
    // another ferret's project, a home of another ferret, a home under another ferret's folder
    expect(sharedLinkAllowed('link-own', { kind: 'root', root: 'work', ferret: F2 }, home)).toBe(false);
    expect(sharedLinkAllowed('link-own', ownWork, { root: 'agent-homes', ferret: F2, subfolder: 'f2' })).toBe(false);
    expect(sharedLinkAllowed('link-own', ownWork, { root: 'agent-homes', ferret: F1, subfolder: 'f2' })).toBe(false);
    expect(sharedLinkAllowed('link-own', ownWork, { root: 'agent-homes', ferret: F1 })).toBe(false);
    // a home handle that names another ferret, even scoped to this ferret's folder
    expect(sharedLinkAllowed('link-own', ownWork, { root: 'agent-homes', ferret: F2, subfolder: 'f1' })).toBe(false);
    // an imports handle scoped to the ferret is still not its work folder
    expect(sharedLinkAllowed('link-own', { kind: 'root', root: 'imports', ferret: F1 }, home)).toBe(false);
    // a work handle with no ferret, an imports folder, a non-home receiver
    expect(sharedLinkAllowed('link-own', { kind: 'root', root: 'work' }, home)).toBe(false);
    expect(sharedLinkAllowed('link-own', { kind: 'root', root: 'imports' }, home)).toBe(false);
    expect(sharedLinkAllowed('link-own', ownWork, { root: 'downloads', ferret: F1, subfolder: 'f1' })).toBe(false);
  });

  test('a scope below the ferret’s own home still counts as its own home (f1/skills)', () => {
    expect(sharedLinkAllowed('link-own', ownWork, { root: 'agent-homes', ferret: F1, subfolder: 'f1/skills' })).toBe(
      true,
    );
  });

  test('no rule links into a root that is not internal', () => {
    expect(sharedLinkAllowed('link-own', state, { root: 'work', ferret: F1 })).toBe(false);
    expect(sharedLinkAllowed('link-internal', state, { root: 'work', ferret: F1 })).toBe(false);
  });
});

describe('RootsPort.share: who may mint, from what', () => {
  test('a plugin that does not declare permissions.shareTrees mints nothing', async () => {
    const w = await world({ shareTrees: false });
    expect(await refusalOf(projectSkill(w))).toBe('not_permitted');
    expect(await refusalOf(w.skills.share({ state: INSTALLED, name: 'abc' }))).toBe('not_permitted');
  });

  test('a root handle another plugin made is refused, even for the same root', async () => {
    const w = await world();
    const theirs = w.claude.root('work', { ferret: F1 });
    expect(await refusalOf(w.skills.share({ root: theirs, path: resolved(theirs, '.claude/skills/local') }))).toBe(
      'not_own',
    );
  });

  test('a forged handle is refused', async () => {
    const w = await world();
    const work = w.skills.root('work', { ferret: F1 });
    const forged = { ...work } as RootHandle;
    expect(await refusalOf(w.skills.share({ root: forged, path: resolved(work, '.claude/skills/local') }))).toBe(
      'not_own',
    );
  });

  test('only work and imports are shareable: never an internal root of the minter’s own', async () => {
    const w = await world();
    const sharer = rootsPortFor(
      fs,
      { home: w.home, plugin: 'claude-code', worktrees: `${w.home}-worktrees` },
      ['agent-homes'],
      () => undefined,
      { shareTrees: true },
    );
    const homes = sharer.root('agent-homes', { subfolder: 'f1' });
    await homes.makeDirectory(resolved(homes, 'x'));
    expect(await refusalOf(sharer.share({ root: homes, path: resolved(homes, 'x') }))).toBe('not_shareable');
  });

  test('state: only one of its own declared opaque named trees, by a path-safe name', async () => {
    const w = await world();
    const undeclared = defineState({ name: 'other', path: 'other/*', store: 'opaque', format: 1 });
    expect(await refusalOf(w.skills.share({ state: undeclared, name: 'abc' }))).toBe('not_own');
    expect(await refusalOf(w.skills.share({ state: INSTALLS, name: 'abc' }))).toBe('not_own');
    const reshaped = defineState({ name: 'installed', path: 'installed/*', store: 'opaque', format: 2 });
    expect(await refusalOf(w.skills.share({ state: reshaped, name: 'abc' }))).toBe('not_own');
    for (const name of ['', '..', 'abc/../..', '../vault', '/abc', 'a//b', '.'])
      expect(await refusalOf(w.skills.share({ state: INSTALLED, name }))).toBe('not_own');
  });

  test('a folder that is not there, or is a file, is refused at mint', async () => {
    const w = await world();
    expect(await refusalOf(w.skills.share({ state: INSTALLED, name: 'missing' }))).toStartWith('root:');
    const work = w.skills.root('work', { ferret: F1 });
    expect(
      await refusalOf(w.skills.share({ root: work, path: resolved(work, '.claude/skills/local/SKILL.md') })),
    ).toStartWith('root:');
  });

  test('a link on the way from the home to the named tree is refused (the base must be exactly where it is named)', async () => {
    const w = await world();
    await mkdir(`${w.parent}/elsewhere/abc`, { recursive: true });
    await writeFile(`${w.parent}/elsewhere/abc/SKILL.md`, 'planted\n');
    await rm(`${w.home}/state/skills/installed`, { recursive: true });
    await symlink(`${w.parent}/elsewhere`, `${w.home}/state/skills/installed`);
    expect(await refusalOf(w.skills.share({ state: INSTALLED, name: 'abc' }))).toBe('root:link_escape');
  });

  test('a work folder inside the home is fenced at mint', async () => {
    const w = await world();
    w.folders.set(F2, `${w.home}/state/skills`);
    const work = w.skills.root('work', { ferret: F2 });
    expect(work.resolve('installed').ok).toBe(false);
    expect(
      await refusalOf(w.skills.share({ root: work, path: `${w.home}/state/skills/installed` as FencedPath })),
    ).toBe('root:fenced');
  });
});

describe('RootHandle.copyShared: materializing', () => {
  test('a project skill is copied into the ferret’s home: every file, modes kept', async () => {
    const w = await world();
    const tree = await projectSkill(w);
    const home = w.homeOf(F1);
    expect(await home.copyShared(tree, resolved(home, 'skills/local'))).toBe('copied');
    const at = `${w.home}/state/claude-code/agent-homes/f1/skills/local`;
    expect((await lstat(at)).isDirectory()).toBe(true);
    expect(await readFile(`${at}/SKILL.md`, 'utf8')).toBe('project skill\n');
  });

  test('an installed skill is copied with its modes, and linked when asked (an internal source)', async () => {
    const w = await world();
    const tree = await w.skills.share({ state: INSTALLED, name: 'abc' });
    const home = w.homeOf(F1);
    expect(await home.copyShared(tree, resolved(home, 'skills/copied'))).toBe('copied');
    const copied = `${w.home}/state/claude-code/agent-homes/f1/skills/copied`;
    expect(await readFile(`${copied}/scripts/run.sh`, 'utf8')).toBe('#!/bin/sh\n');
    expect((await stat(`${copied}/scripts/run.sh`)).mode & 0o777).toBe(0o755);
    expect(await home.copyShared(tree, resolved(home, 'skills/abc'), { link: true })).toBe('linked');
    const linked = `${w.home}/state/claude-code/agent-homes/f1/skills/abc`;
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await readlink(linked)).toBe(w.installedPath);
  });

  test('link-internal (the default): a link asked for a project skill is a COPY, never a link', async () => {
    const w = await world();
    const tree = await projectSkill(w);
    const home = w.homeOf(F1);
    expect(await home.copyShared(tree, resolved(home, 'skills/local'), { link: true })).toBe('copied');
    expect((await lstat(`${w.home}/state/claude-code/agent-homes/f1/skills/local`)).isSymbolicLink()).toBe(false);
  });

  test('link-own: the ferret’s own project skill is linked into its own home; another ferret’s home gets a copy', async () => {
    const w = await world({ linkRule: 'link-own' });
    const tree = await projectSkill(w);
    const own = w.homeOf(F1);
    expect(await own.copyShared(tree, resolved(own, 'skills/local'), { link: true })).toBe('linked');
    expect(await readlink(`${w.home}/state/claude-code/agent-homes/f1/skills/local`)).toBe(
      `${w.project}/.claude/skills/local`,
    );
    const other = w.homeOf(F2);
    expect(await other.copyShared(tree, resolved(other, 'skills/local'), { link: true })).toBe('copied');
    // a handle that names f1 but is scoped to f2's folder is not f1's own home
    const mislabelled = w.homeOf(F1, 'f2');
    expect(await mislabelled.copyShared(tree, resolved(mislabelled, 'skills/again'), { link: true })).toBe('copied');
    // without link, link-own copies too
    expect(await own.copyShared(tree, resolved(own, 'skills/plain'))).toBe('copied');
  });

  test('a link inside the tree is skipped, never followed', async () => {
    const w = await world();
    await writeFile(`${w.parent}/outside.txt`, 'outside\n');
    await symlink(`${w.parent}/outside.txt`, `${w.project}/.claude/skills/local/escape.md`);
    await symlink(`${w.home}/state`, `${w.project}/.claude/skills/local/state`);
    const tree = await projectSkill(w);
    const home = w.homeOf(F1);
    await home.copyShared(tree, resolved(home, 'skills/local'));
    const at = `${w.home}/state/claude-code/agent-homes/f1/skills/local`;
    await expect(lstat(`${at}/escape.md`)).rejects.toThrow();
    await expect(lstat(`${at}/state`)).rejects.toThrow();
    expect(await readFile(`${at}/SKILL.md`, 'utf8')).toBe('project skill\n');
  });

  test('a file with a second hard link is skipped, never read', async () => {
    const w = await world();
    await writeFile(`${w.parent}/private.txt`, 'private\n');
    await link(`${w.parent}/private.txt`, `${w.project}/.claude/skills/local/linked.txt`);
    const tree = await projectSkill(w);
    const home = w.homeOf(F1);
    await home.copyShared(tree, resolved(home, 'skills/local'));
    await expect(lstat(`${w.home}/state/claude-code/agent-homes/f1/skills/local/linked.txt`)).rejects.toThrow();
  });

  test('maxEntries bounds the walk', async () => {
    const w = await world();
    const tree = await w.skills.share({ state: INSTALLED, name: 'abc' });
    const home = w.homeOf(F1);
    expect(await refusalOf(home.copyShared(tree, resolved(home, 'skills/abc'), { maxEntries: 1 }))).toBe(
      'root:outside',
    );
  });

  test('the destination must be NEW: something already at the name is refused (a planted link redirects nothing)', async () => {
    const w = await world();
    const tree = await projectSkill(w);
    const home = w.homeOf(F1);
    await mkdir(`${w.home}/state/claude-code/agent-homes/f1/skills`, { recursive: true });
    await symlink(w.project, `${w.home}/state/claude-code/agent-homes/f1/skills/local`);
    expect(await refusalOf(home.copyShared(tree, resolved(home, 'skills/local')))).toBe('root:outside');
  });

  test('a non-internal destination is refused before the tree is opened', async () => {
    const w = await world();
    const tree = await projectSkill(w);
    const work = w.claude.root('work', { ferret: F1 });
    expect(await refusalOf(work.copyShared(tree, resolved(work, 'copied')))).toBe('not_internal');
    expect(await refusalOf(work.copyShared({} as SharedTree, resolved(work, 'copied')))).toBe('not_internal');
  });
});

describe('a shared tree is unforgeable and lives as long as its minter', () => {
  test('a forged object, a spread copy and a JSON round trip open nothing', async () => {
    const w = await world();
    const tree = await projectSkill(w);
    const home = w.homeOf(F1);
    expect(JSON.stringify(tree)).toBe('{"shared":"local"}');
    expect(Object.keys(tree)).toEqual([]);
    expect(JSON.stringify(tree)).not.toContain(w.project);
    for (const fake of [{}, { ...tree }, JSON.parse(JSON.stringify(tree)), null, 'local'] as unknown as SharedTree[])
      expect(await refusalOf(home.copyShared(fake, resolved(home, 'skills/fake')))).toBe('not_shared');
    await expect(lstat(`${w.home}/state/claude-code/agent-homes/f1/skills/fake`)).rejects.toThrow();
  });

  test('a tree is frozen: nothing can be added to it', async () => {
    const w = await world();
    const tree = await projectSkill(w);
    expect(Object.isFrozen(tree)).toBe(true);
  });

  test('the minter’s stop revokes every tree it minted', async () => {
    const w = await world();
    const tree = await w.skills.share({ state: INSTALLED, name: 'abc' });
    const home = w.homeOf(F1);
    expect(await home.copyShared(tree, resolved(home, 'skills/before'))).toBe('copied');
    w.stopSkills();
    expect(await refusalOf(home.copyShared(tree, resolved(home, 'skills/after')))).toBe('not_shared');
  });

  test('a link is made only to a tree still there: one removed after the mint is refused, and no dangling link is left', async () => {
    const w = await world();
    const tree = await w.skills.share({ state: INSTALLED, name: 'abc' });
    await rm(w.installedPath, { recursive: true });
    const home = w.homeOf(F1);
    expect(await refusalOf(home.copyShared(tree, resolved(home, 'skills/abc'), { link: true }))).toStartWith('root:');
    await expect(lstat(`${w.home}/state/claude-code/agent-homes/f1/skills/abc`)).rejects.toThrow();
  });

  test('link-own: the source is checked again at the link: a ferret whose work folder is gone gets no link', async () => {
    const w = await world({ linkRule: 'link-own' });
    const tree = await projectSkill(w);
    w.folders.delete(F1);
    const home = w.homeOf(F1);
    expect(await refusalOf(home.copyShared(tree, resolved(home, 'skills/local'), { link: true }))).toBe(
      'root:unknown_ferret',
    );
    await expect(lstat(`${w.home}/state/claude-code/agent-homes/f1/skills/local`)).rejects.toThrow();
  });

  test('the source is checked again at the copy: a ferret whose work folder is gone yields nothing', async () => {
    const w = await world();
    const tree = await projectSkill(w);
    w.folders.delete(F1);
    const home = w.homeOf(F1);
    expect(await refusalOf(home.copyShared(tree, resolved(home, 'skills/local')))).toBe('root:unknown_ferret');
  });
});
