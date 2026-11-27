import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallContext, KernelPorts, SpawnPort } from '@ferretry/kernel/contract';
import { nodeFs } from '../../../../../core/kernel/host/adapters/node-fs.ts';
import { platformRootPinner } from '../../../../../core/kernel/host/adapters/pinned/index.ts';
import { restrictSpawn } from '../../../../../core/kernel/host/permissions.ts';
import { PinRegistry } from '../../../../../core/kernel/host/pins.ts';
import { rootsPortFor } from '../../../../../core/kernel/host/roots.ts';
import { kernelFolders } from '../../../daemon/adapters/folders.ts';
import { kernelBrowser } from '../../../daemon/features/folders/adapter.ts';
import { isAtOrUnder } from '../../../daemon/features/folders/fence.ts';
import { cloneRoute } from '../../../daemon/features/repos/routes.ts';
import { fakeMachine, registryOver } from '../../unit/daemon/support.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const path of parents.splice(0)) await rm(path, { recursive: true, force: true });
});

const ADDRESS = 'https://example.invalid/source.git';
const execute = async (program: string, args: readonly string[], cwd?: string) => {
  const child = Bun.spawn([program, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode, signal: null };
};

async function world() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'fy-clone-safety-')));
  parents.push(parent);
  const user = join(parent, 'user');
  const project = join(user, 'work');
  const outside = join(parent, 'outside');
  const bare = join(outside, 'source.git');
  for (const path of [project, outside, join(parent, 'fy-home')]) await mkdir(path, { recursive: true });
  expect((await execute('git', ['init', '--bare', bare])).exitCode).toBe(0);
  let beforeClone: (() => Promise<void>) | undefined;
  let beforeMkdir: (() => Promise<void>) | undefined;
  const clones: { args: readonly string[]; cwd: unknown; env: unknown }[] = [];
  const host: SpawnPort = {
    run: async (program, args, options) => {
      if (program === 'mkdir') await beforeMkdir?.();
      if (program === 'git' && args.includes('clone')) {
        clones.push({ args, cwd: options?.cwd, env: options?.env });
        await beforeClone?.();
        // Test transport only: hand the real Git child a local bare fixture, never contact a remote.
        args = args.map(arg => (/^(https|ssh):/u.test(arg) ? bare : arg));
      }
      return execute(program, args, options?.cwd as string | undefined);
    },
    runBytes: async () => {
      throw new Error('unused');
    },
    start: () => {
      throw new Error('unused');
    },
  };
  const pins = new PinRegistry(() => platformRootPinner());
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: join(parent, 'fy-home'), plugin: 'projects', worktrees: join(parent, 'worktrees') },
    ['imports'],
    () => undefined,
    { pins },
  );
  const kernel = {
    roots,
    spawn: restrictSpawn('projects', ['git', 'mkdir', 'rmdir'], host, undefined, pins),
    paths: { home: () => user },
  } as unknown as Pick<KernelPorts, 'roots' | 'spawn' | 'paths'>;
  const folders = kernelFolders(kernel);
  const real = kernelBrowser(kernel);
  const browser = {
    ...real,
    holdsSignIn: (path: string) => (isAtOrUnder(path, user) ? real.holdsSignIn(path) : Promise.resolve(false)),
  };
  const { registry } = registryOver(fakeMachine([project]));
  const registered = await registry.register({ kind: 'existing-folder', path: project });
  if (!registered.ok) throw new Error('registration failed');
  const run = (url = ADDRESS, scan = { browser }) =>
    cloneRoute(
      registry,
      folders,
      scan,
    )({
      params: new Map([['id', registered.value.id]]),
      request: { text: async () => JSON.stringify({ url }) },
      governance: { governed: false, decide: () => ({ allowed: true, refusal: 'granted' }) },
    } as unknown as CallContext);
  return {
    parent,
    project,
    outside,
    bare,
    user,
    run,
    clones,
    browser,
    beforeClone: (hook: () => Promise<void>) => {
      beforeClone = hook;
    },
    beforeMkdir: (hook: () => Promise<void>) => {
      beforeMkdir = hook;
    },
  };
}

describe('clone safety before Git writes (PR 2636 MUST 1-4)', () => {
  test('MUST 1: a registered project swapped for a symlink is refused before any clone, outside untouched', async () => {
    const w = await world();
    await rename(w.project, `${w.project}-held`);
    await symlink(w.outside, w.project);
    await expect(w.run()).rejects.toMatchObject({ status: 422 });
    expect(w.clones).toEqual([]);
    expect(await readdir(w.outside)).toEqual(['source.git']);
  });
  test('MUST 1: an ancestor now linked outside cannot redirect the project', async () => {
    const w = await world();
    await mkdir(join(w.outside, 'work'));
    await rename(w.user, `${w.user}-held`);
    await symlink(w.outside, w.user);
    await expect(w.run()).rejects.toMatchObject({ status: 422 });
    expect(w.clones).toEqual([]);
    expect(await readdir(join(w.outside, 'work'))).toEqual([]);
  });
  test('MUST 1: an existing empty destination, file or link is never clobbered', async () => {
    for (const kind of ['directory', 'file', 'link']) {
      const w = await world();
      const target = join(w.project, 'source');
      if (kind === 'directory') await mkdir(target);
      else if (kind === 'file') await writeFile(target, 'keep');
      else await symlink(w.outside, target);
      await expect(w.run()).rejects.toMatchObject({ status: 422 });
      expect(w.clones).toEqual([]);
      expect(await readdir(w.outside)).toEqual(['source.git']);
    }
  });
  test('MUST 1: a parent swapped after judgment cannot redirect mkdir or Git', async () => {
    const w = await world();
    w.beforeMkdir(async () => {
      await rename(w.project, `${w.project}-held`);
      await symlink(w.outside, w.project);
    });
    await expect(w.run()).rejects.toMatchObject({ status: 422 });
    expect(w.clones).toEqual([]);
    expect(await readdir(w.outside)).toEqual(['source.git']);
  });
  test('MUST 1: a destination swapped just before Git starts cannot redirect its writes', async () => {
    const w = await world();
    const target = join(w.project, 'source');
    w.beforeClone(async () => {
      await rename(target, `${target}-held`);
      await symlink(w.outside, target);
    });
    await expect(w.run()).rejects.toMatchObject({ status: 422 });
    expect(await readdir(w.outside)).toEqual(['source.git']);
    expect(await readdir(`${target}-held`)).toContain('.git');
  });
  test('MUST 1: the shared folder policy refuses a project holding sign-in material before writing', async () => {
    const w = await world();
    await writeFile(join(w.project, 'Auth.JSON'), '{}');
    await expect(w.run()).rejects.toMatchObject({ status: 422 });
    expect(w.clones).toEqual([]);
    expect(await readdir(w.project)).toEqual(['Auth.JSON']);
  });
  test('MUST 2: a local file source outside folder policy is refused before Git reads it', async () => {
    const w = await world();
    await expect(w.run(`file://${w.bare}`)).rejects.toMatchObject({ status: 400 });
    expect(w.clones).toEqual([]);
    await expect(w.run(w.bare)).rejects.toMatchObject({ status: 400 });
  });
  test('MUST 3: inline credentials are refused with Accounts/secrets guidance and never echoed', async () => {
    const w = await world();
    for (const url of [
      'https://fixture-user:fixture-secret@example.invalid/source.git',
      'https://fixture-secret@example.invalid/source.git',
      'ssh://git:fixture-secret@example.invalid/source.git',
    ]) {
      let refusal: unknown;
      try {
        await w.run(url);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toMatchObject({ status: 400 });
      expect(String(refusal)).toMatch(/Accounts|secrets/u);
      expect(String(refusal)).not.toContain('fixture-secret');
    }
    expect(w.clones).toEqual([]);
  });
  test('MUST 4: hidden and scanner-skipped names are refused before writing', async () => {
    const w = await world();
    for (const name of ['.hidden', 'node_modules'])
      await expect(w.run(`https://example.invalid/${name}.git`)).rejects.toMatchObject({ status: 422 });
    expect(w.clones).toEqual([]);
    expect(await readdir(w.project)).toEqual([]);
  });
  test('MUST 4: a Git-backed project gets a clear refusal before writing', async () => {
    const w = await world();
    expect((await execute('git', ['init', w.project])).exitCode).toBe(0);
    await expect(w.run()).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('itself a repository'),
    });
    expect(w.clones).toEqual([]);
  });
  test('MUST 4: a post-clone scan that cannot see the new repository never reports success', async () => {
    const w = await world();
    // It is safe before the clone; after Git finishes, the scanner cannot read it.
    const hidden = {
      ...w.browser,
      open: async (...args: Parameters<typeof w.browser.open>) =>
        w.clones.length === 0 ? w.browser.open(...args) : { ok: false as const, reason: 'refused' as const },
    };
    await expect(w.run(ADDRESS, { browser: hidden })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('could not be listed'),
    });
    expect(w.clones).toHaveLength(1);
  });
  test('a real Git clone is listed; its destination and parent are held, with remote-only transports', async () => {
    const w = await world();
    const response = await w.run();
    expect(response.status).toBe(200);
    expect(JSON.parse(String(response.body)).repos.map((repo: { path: string }) => repo.path)).toEqual(['source']);
    expect(w.clones[0]?.args.at(-1)).toBe('.');
    expect(w.clones[0]?.cwd).toBeDefined();
    expect(w.clones[0]?.env).toMatchObject({ GIT_ALLOW_PROTOCOL: 'https:ssh' });
  });
});
