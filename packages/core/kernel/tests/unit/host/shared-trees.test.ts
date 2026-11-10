/**
 * Shared trees (kernel batch #10, rulings #52 Q2 + Q5, owner decision !A466): `RootsPort.share` mints ONE folder of the minter's own state, and
 * `RootHandle.copyShared` materializes it in the receiver's internal root, on the real roots port and a real disk.
 * Who may mint, from what, into what, that a link is made only from internal state, and that a forged, rebuilt or revoked tree opens nothing.
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
import { SharedTreeError } from '../../../host/shared-trees.ts';

const INSTALLED = defineState({ name: 'installed', path: 'installed/*', store: 'opaque', format: 1 });
const INSTALLS = defineState({ name: 'installs', path: 'installs.json', store: 'json', format: 1 });
const CREDENTIALS = defineState({ name: 'credentials', path: 'credentials/*', store: 'opaque', format: 1 });
const SESSIONS = defineState({ name: 'sessions', path: 'sessions/*', store: 'opaque', format: 1 });
const F1 = 'f1' as FerretId;

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const fs = nodeFs(() => crypto.randomUUID());

/** A home, a project outside it (ferret f1's work folder), and Skills' installed skill `abc`. */
async function world(options: { readonly shareTrees?: boolean } = {}) {
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
      stateFiles: [INSTALLED, INSTALLS, CREDENTIALS, SESSIONS],
      onStop: fn => stops.push(fn),
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

const installedSkill = async (w: Awaited<ReturnType<typeof world>>): Promise<SharedTree> =>
  await w.skills.share({ state: INSTALLED, name: 'abc' });

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

describe('RootsPort.share: who may mint, from what', () => {
  test('a plugin that does not declare permissions.shareTrees mints nothing', async () => {
    const w = await world({ shareTrees: false });
    expect(await refusalOf(installedSkill(w))).toBe('not_permitted');
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

  test('a state tree under a kernel-made root folder mints nothing (credentials, sessions are never shareable)', async () => {
    const w = await world();
    await mkdir(`${w.home}/state/skills/credentials/login-a`, { recursive: true, mode: 0o700 });
    await mkdir(`${w.home}/state/skills/sessions/s1`, { recursive: true, mode: 0o700 });
    expect(await refusalOf(w.skills.share({ state: CREDENTIALS, name: 'login-a' }))).toBe('not_own');
    expect(await refusalOf(w.skills.share({ state: SESSIONS, name: 's1' }))).toBe('not_own');
    // a name that merely spells a root folder under a shareable def is still fine
    await mkdir(`${w.home}/state/skills/installed/sessions`, { recursive: true, mode: 0o700 });
    expect(await refusalOf(w.skills.share({ state: INSTALLED, name: 'sessions' }))).toBe('none');
  });

  test('no folder of an owner’s root is shareable: the source type has no root variant', async () => {
    const w = await world();
    const work = w.skills.root('work', { ferret: F1 });
    const asked = { root: work, path: resolved(work, '.claude/skills/local') };
    expect(await refusalOf(w.skills.share(asked as never))).toBe('not_own');
  });

  test('a folder that is not there is refused at mint', async () => {
    const w = await world();
    expect(await refusalOf(w.skills.share({ state: INSTALLED, name: 'missing' }))).toStartWith('root:');
  });

  test('a link on the way from the home to the named tree is refused (the base must be exactly where it is named)', async () => {
    const w = await world();
    await mkdir(`${w.parent}/elsewhere/abc`, { recursive: true });
    await writeFile(`${w.parent}/elsewhere/abc/SKILL.md`, 'planted\n');
    await rm(`${w.home}/state/skills/installed`, { recursive: true });
    await symlink(`${w.parent}/elsewhere`, `${w.home}/state/skills/installed`);
    expect(await refusalOf(w.skills.share({ state: INSTALLED, name: 'abc' }))).toBe('root:link_escape');
  });
});

describe('RootHandle.copyShared: materializing', () => {
  test('an installed skill is copied with its modes, and linked when asked (the one link rule)', async () => {
    const w = await world();
    const tree = await installedSkill(w);
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

  test('a link inside the tree is skipped, never followed', async () => {
    const w = await world();
    await writeFile(`${w.parent}/outside.txt`, 'outside\n');
    await symlink(`${w.parent}/outside.txt`, `${w.installedPath}/escape.md`);
    await symlink(`${w.home}/state`, `${w.installedPath}/state`);
    const tree = await installedSkill(w);
    const home = w.homeOf(F1);
    await home.copyShared(tree, resolved(home, 'skills/local'));
    const at = `${w.home}/state/claude-code/agent-homes/f1/skills/local`;
    await expect(lstat(`${at}/escape.md`)).rejects.toThrow();
    await expect(lstat(`${at}/state`)).rejects.toThrow();
    expect(await readFile(`${at}/SKILL.md`, 'utf8')).toBe('installed skill\n');
  });

  test('a file with a second hard link is skipped, never read', async () => {
    const w = await world();
    await writeFile(`${w.parent}/private.txt`, 'private\n');
    await link(`${w.parent}/private.txt`, `${w.installedPath}/linked.txt`);
    const tree = await installedSkill(w);
    const home = w.homeOf(F1);
    await home.copyShared(tree, resolved(home, 'skills/local'));
    await expect(lstat(`${w.home}/state/claude-code/agent-homes/f1/skills/local/linked.txt`)).rejects.toThrow();
  });

  test('maxEntries bounds the walk', async () => {
    const w = await world();
    const tree = await installedSkill(w);
    const home = w.homeOf(F1);
    expect(await refusalOf(home.copyShared(tree, resolved(home, 'skills/abc'), { maxEntries: 1 }))).toBe(
      'root:outside',
    );
  });

  test('the destination must be NEW: something already at the name is refused (a planted link redirects nothing)', async () => {
    const w = await world();
    const tree = await installedSkill(w);
    const home = w.homeOf(F1);
    await mkdir(`${w.home}/state/claude-code/agent-homes/f1/skills`, { recursive: true });
    await symlink(w.project, `${w.home}/state/claude-code/agent-homes/f1/skills/local`);
    expect(await refusalOf(home.copyShared(tree, resolved(home, 'skills/local')))).toBe('root:outside');
  });

  test('a destination that is not agent-homes is refused before the tree is opened', async () => {
    const w = await world();
    const tree = await installedSkill(w);
    const work = w.claude.root('work', { ferret: F1 });
    expect(await refusalOf(work.copyShared(tree, resolved(work, 'copied')))).toBe('not_internal');
    expect(await refusalOf(work.copyShared({} as SharedTree, resolved(work, 'copied')))).toBe('not_internal');
    const other = rootsPortFor(
      fs,
      { home: w.home, plugin: 'claude-code', worktrees: `${w.home}-worktrees` },
      ['downloads'],
      () => undefined,
    ).root('downloads');
    expect(await refusalOf(other.copyShared(tree, resolved(other, 'copied')))).toBe('not_internal');
  });
});

describe('a shared tree is unforgeable and lives as long as its minter', () => {
  test('a forged object, a spread copy and a JSON round trip open nothing', async () => {
    const w = await world();
    const tree = await installedSkill(w);
    const home = w.homeOf(F1);
    expect(JSON.stringify(tree)).toBe('{"shared":"abc"}');
    expect(Object.keys(tree)).toEqual([]);
    expect(JSON.stringify(tree)).not.toContain(w.home);
    for (const fake of [{}, { ...tree }, JSON.parse(JSON.stringify(tree)), null, 'abc'] as unknown as SharedTree[])
      expect(await refusalOf(home.copyShared(fake, resolved(home, 'skills/fake')))).toBe('not_shared');
    await expect(lstat(`${w.home}/state/claude-code/agent-homes/f1/skills/fake`)).rejects.toThrow();
  });

  test('a tree is frozen: nothing can be added to it', async () => {
    const w = await world();
    expect(Object.isFrozen(await installedSkill(w))).toBe(true);
  });

  test('the minter’s stop revokes every tree it minted', async () => {
    const w = await world();
    const tree = await installedSkill(w);
    const home = w.homeOf(F1);
    expect(await home.copyShared(tree, resolved(home, 'skills/before'))).toBe('copied');
    w.stopSkills();
    expect(await refusalOf(home.copyShared(tree, resolved(home, 'skills/after')))).toBe('not_shared');
  });

  test('a link is made only to a tree still there: one removed after the mint is refused, and no dangling link is left', async () => {
    const w = await world();
    const tree = await installedSkill(w);
    await rm(w.installedPath, { recursive: true });
    const home = w.homeOf(F1);
    expect(await refusalOf(home.copyShared(tree, resolved(home, 'skills/abc'), { link: true }))).toStartWith('root:');
    await expect(lstat(`${w.home}/state/claude-code/agent-homes/f1/skills/abc`)).rejects.toThrow();
  });
});
