/**
 * The repository scan over the kernel's REAL `imports` root on a temp disk (never a real home): a fake user home holding a
 * project with repositories at several depths, a link out of the project to a repository, a repository under a private
 * folder, and a remote that carries a token. Linux only for the held-folder reach, as `folders-disk.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KernelPorts, SpawnPort } from '@ferretry/kernel/contract';
import { nodeFs } from '../../../../../core/kernel/host/adapters/node-fs.ts';
import { platformRootPinner } from '../../../../../core/kernel/host/adapters/pinned/index.ts';
import { restrictSpawn } from '../../../../../core/kernel/host/permissions.ts';
import { PinRegistry } from '../../../../../core/kernel/host/pins.ts';
import { rootsPortFor } from '../../../../../core/kernel/host/roots.ts';
import { kernelBrowser } from '../../../daemon/features/folders/adapter.ts';
import { scanRepos } from '../../../daemon/features/repos/scan.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const noSpawn: SpawnPort = {
  run: async () => {
    throw new Error('not used');
  },
  runBytes: async () => {
    throw new Error('not used');
  },
  start: () => {
    throw new Error('not used');
  },
};

const CONFIG = (url: string) => `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n`;

async function world() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-repos-`));
  parents.push(parent);
  const user = join(parent, 'user');
  const project = join(user, 'work');
  const outside = join(parent, 'outside');
  for (const folder of [
    join(project, 'app', '.git'),
    join(project, 'group', 'lib', '.git'),
    join(project, 'group', 'plain'),
    join(project, 'p', 'q', 'r', 's', 't', '.git'),
    join(project, 'a', 'b', 'c', 'd', 'e', 'too-deep', '.git'),
    join(project, 'node_modules', 'dep', '.git'),
    join(project, '.hidden', 'r', '.git'),
    join(project, 'worktree'),
    join(outside, 'stolen', '.git'),
    join(user, '.ssh', 'r', '.git'),
    join(parent, 'fy-home', 'state'),
  ])
    await mkdir(folder, { recursive: true });
  await writeFile(join(project, 'app', '.git', 'config'), CONFIG('https://me:ghp_TOKEN123@github.com/me/app.git'));
  await writeFile(join(project, 'group', 'lib', '.git', 'config'), CONFIG('git@gitlab.example.com:team/lib.git'));
  // a work tree keeps a `.git` FILE, not a folder
  await writeFile(join(project, 'worktree', '.git'), 'gitdir: /elsewhere');
  await writeFile(join(outside, 'stolen', '.git', 'config'), CONFIG('https://github.com/evil/stolen'));
  await symlink(join(outside, 'stolen'), join(project, 'linked-out'));
  await symlink(join(user, '.ssh'), join(project, 'to-ssh'));
  const pins = new PinRegistry(() => platformRootPinner());
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: join(parent, 'fy-home'), plugin: 'projects', worktrees: `${join(parent, 'fy-home')}-w` },
    ['imports'],
    () => undefined,
    { pins },
  );
  const spawn = restrictSpawn('projects', ['mkdir', 'rmdir'], noSpawn, undefined, pins);
  const kernel = { roots, paths: { home: () => user }, spawn } as unknown as Pick<
    KernelPorts,
    'roots' | 'paths' | 'spawn'
  >;
  return { user, project, outside, deps: { browser: kernelBrowser(kernel) } };
}

describe('the repository scan over the real imports root', () => {
  test('finds repositories to depth five, reads their remotes, and keeps the token out', async () => {
    const w = await world();
    const found = await scanRepos(w.project, w.deps);
    expect(found.repos).toEqual([
      { path: 'app', remote: 'https://github.com/me/app', provider: 'github' },
      { path: 'group/lib', remote: 'https://gitlab.example.com/team/lib' },
      { path: 'p/q/r/s/t' },
      { path: 'worktree' },
    ]);
    expect(found.truncated).toBe(false);
    expect(JSON.stringify(found)).not.toContain('TOKEN123');
  });
  test('never follows a link out of the project, into a private folder, or under node_modules and hidden folders', async () => {
    const w = await world();
    const paths = (await scanRepos(w.project, w.deps)).repos.map(repo => repo.path);
    for (const never of ['linked-out', 'to-ssh', 'node_modules/dep', '.hidden/r', 'a/b/c/d/e/too-deep'])
      expect(paths).not.toContain(never);
    expect(JSON.stringify(paths)).not.toContain('stolen');
  });
  test('a project folder that is itself a link is refused; one that is a repository answers itself', async () => {
    const w = await world();
    const viaLink = join(w.user, 'alias');
    await symlink(w.project, viaLink);
    expect(await scanRepos(viaLink, w.deps)).toEqual({ repos: [], truncated: true });
    const toSsh = join(w.user, 'stowed-project');
    await symlink(join(w.user, '.ssh'), toSsh);
    expect(await scanRepos(toSsh, w.deps)).toEqual({ repos: [], truncated: true });
    expect((await scanRepos(join(w.project, 'app'), w.deps)).repos).toEqual([
      { path: '.', remote: 'https://github.com/me/app', provider: 'github' },
    ]);
  });
  test('a project outside the home is scanned; a link from it into a private folder is not followed; a skipped tree answers truncated', async () => {
    const w = await world();
    await mkdir(join(w.outside, 'srv', 'svc', '.git'), { recursive: true });
    await writeFile(join(w.outside, 'srv', 'svc', '.git', 'config'), CONFIG('https://github.com/me/svc'));
    await symlink(join(w.user, '.ssh'), join(w.outside, 'srv', 'to-ssh'));
    const found = await scanRepos(join(w.outside, 'srv'), w.deps);
    // Every folder above a project outside the home is looked at for a sign-in file by NAME (a stat of each marker), so how
    // wide an ancestor is (this machine's temp folder included) decides nothing: the answer is the same on any machine.
    expect(found).toEqual({
      repos: [{ path: 'svc', remote: 'https://github.com/me/svc', provider: 'github' }],
      truncated: false,
    });
    // `/proc` is a pseudo filesystem: a project there is refused on the real path, nothing is opened, and it is not "empty".
    expect(await scanRepos('/proc', w.deps)).toEqual({ repos: [], truncated: true });
  });
  /** `count` empty files in `folder`, made by the shell: the count is the point, not thousands of promises. */
  const fill = async (folder: string, count: number) => {
    await mkdir(folder, { recursive: true });
    const made = Bun.spawn(['sh', '-c', `seq -f n%g ${count} | xargs touch`], { cwd: folder });
    expect(await made.exited).toBe(0);
  };
  test('a child folder wider than the sign-in look reads is NOT proved safe (R3): not indexed, and the answer is truncated so stored repositories are kept', async () => {
    const w = await world();
    await mkdir(join(w.project, 'wide', '.git'), { recursive: true });
    await writeFile(join(w.project, 'wide', '.git', 'config'), CONFIG('https://github.com/me/wide'));
    await fill(join(w.project, 'wide'), 5001);
    // a marker in an odd spelling (the known names are asked for exactly, so only the fold would see it)
    await writeFile(join(w.project, 'wide', 'ID_RSA'), 'not a key');
    const found = await scanRepos(w.project, w.deps);
    expect(found.repos.map(repo => repo.path)).not.toContain('wide');
    expect(found.repos.map(repo => repo.path)).toContain('app');
    // wherever the marker sits in the listing, the folder is either refused as a sign-in one or unproved: never exposed
    expect(JSON.stringify(found)).not.toContain('me/wide');
    // with no marker anywhere the look is deterministic: unproved, so truncated (never "whole")
    await mkdir(join(w.project, 'wide-plain', '.git'), { recursive: true });
    await fill(join(w.project, 'wide-plain'), 5001);
    const plain = await scanRepos(w.project, w.deps);
    expect(plain.repos.map(repo => repo.path)).not.toContain('wide-plain');
    expect(plain.truncated).toBe(true);
  });
  test('how WIDE a folder is decides nothing about the project folder itself: a repository that is 5,001 names wide still answers itself', async () => {
    const w = await world();
    await mkdir(join(w.project, 'wide', 'proj', '.git'), { recursive: true });
    await writeFile(join(w.project, 'wide', 'proj', '.git', 'config'), CONFIG('https://github.com/me/proj'));
    await fill(join(w.project, 'wide', 'proj'), 5001);
    // a project folder below a wide ordinary ancestor
    await mkdir(join(w.outside, 'srv', 'svc', '.git'), { recursive: true });
    await fill(w.outside, 5001);
    const inside = await scanRepos(w.project, w.deps);
    // a 5,001-name CHILD is not proved free of an odd-spelled marker (R3): not indexed, and the answer is truncated
    expect(inside.repos.map(repo => repo.path)).not.toContain('wide/proj');
    expect(inside.truncated).toBe(true);
    const below = await scanRepos(join(w.outside, 'srv'), w.deps);
    expect(below).toEqual({ repos: [{ path: 'svc' }], truncated: false });
    // a repository that is itself 5,001 names wide
    expect(await scanRepos(join(w.project, 'wide', 'proj'), w.deps)).toEqual({
      repos: [{ path: '.', remote: 'https://github.com/me/proj', provider: 'github' }],
      truncated: false,
    });
  });
  test('a sign-in file is still found by name in a wide folder: that child is skipped, wide or not', async () => {
    const w = await world();
    await mkdir(join(w.project, 'keys', '.git'), { recursive: true });
    await fill(join(w.project, 'keys'), 5001);
    await writeFile(join(w.project, 'keys', 'id_ed25519'), 'not a key');
    const found = await scanRepos(w.project, w.deps);
    expect(found.repos.map(repo => repo.path)).not.toContain('keys');
  });
  test('a link where `.git/config` should be is not read: the repository shows no remote', async () => {
    const w = await world();
    await rm(join(w.project, 'app', '.git', 'config'));
    await symlink(join(w.outside, 'stolen', '.git', 'config'), join(w.project, 'app', '.git', 'config'));
    const found = await scanRepos(w.project, w.deps);
    expect(found.repos.find(repo => repo.path === 'app')).toEqual({ path: 'app' });
    expect(JSON.stringify(found)).not.toContain('evil');
  });
  test('a child that is a link to a private folder and a child that holds a sign-in file are not looked into', async () => {
    const w = await world();
    await mkdir(join(w.project, 'keys', '.git'), { recursive: true });
    await writeFile(join(w.project, 'keys', 'id_ed25519'), 'not a key');
    await writeFile(join(w.project, 'keys', '.git', 'config'), CONFIG('https://github.com/me/keys'));
    const found = await scanRepos(w.project, w.deps);
    expect(found.repos.map(repo => repo.path)).not.toContain('keys');
    expect(found.repos.map(repo => repo.path)).not.toContain('to-ssh');
  });
});
