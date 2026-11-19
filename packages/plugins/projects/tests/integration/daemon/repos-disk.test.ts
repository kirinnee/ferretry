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
import { kernelConfigReader } from '../../../daemon/features/repos/adapter.ts';
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
    join(project, 'a', 'b', 'c', 'too-deep', '.git'),
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
  return { user, project, outside, deps: { browser: kernelBrowser(kernel), readConfig: kernelConfigReader(kernel) } };
}

describe('the repository scan over the real imports root', () => {
  test('finds repositories to depth three, reads their remotes, and keeps the token out', async () => {
    const w = await world();
    const found = await scanRepos(w.project, w.deps);
    expect(found.repos).toEqual([
      { path: 'app', remote: 'https://github.com/me/app', provider: 'github' },
      { path: 'group/lib', remote: 'https://gitlab.example.com/team/lib' },
      { path: 'worktree' },
    ]);
    expect(found.truncated).toBe(false);
    expect(JSON.stringify(found)).not.toContain('TOKEN123');
  });
  test('never follows a link out of the project, into a private folder, or under node_modules and hidden folders', async () => {
    const w = await world();
    const paths = (await scanRepos(w.project, w.deps)).repos.map(repo => repo.path);
    for (const never of ['linked-out', 'to-ssh', 'node_modules/dep', '.hidden/r', 'a/b/c/too-deep'])
      expect(paths).not.toContain(never);
    expect(JSON.stringify(paths)).not.toContain('stolen');
  });
  test('a project reached through a link answers its real folder; one that is a repository answers itself', async () => {
    const w = await world();
    const viaLink = join(w.user, 'alias');
    await symlink(w.project, viaLink);
    expect((await scanRepos(viaLink, w.deps)).repos.map(repo => repo.path)).toContain('app');
    expect((await scanRepos(join(w.project, 'app'), w.deps)).repos).toEqual([
      { path: '.', remote: 'https://github.com/me/app', provider: 'github' },
    ]);
  });
  test('the config reader refuses a link where `.git/config` should be', async () => {
    const w = await world();
    await rm(join(w.project, 'app', '.git', 'config'));
    await symlink(join(w.outside, 'stolen', '.git', 'config'), join(w.project, 'app', '.git', 'config'));
    expect(await w.deps.readConfig(join(w.project, 'app'))).toBeUndefined();
  });
});
