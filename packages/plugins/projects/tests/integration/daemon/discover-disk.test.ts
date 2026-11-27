/**
 * Auto-registering repositories at ferret start (W-42, V-B1) over REAL git on a temp disk, driven through the real
 * `ferret.started` event: a stand-in for Ferrets offers the hook and observes it, Projects hears it exactly as the kernel
 * delivers it. The home is a fake one inside the fixture (never a real home), and the fixture is its own small tree.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FerretId, FerretStarted, type FerretStartedPayload } from '@ferretry/core-ferrets/contract';
import type { KernelPorts, SpawnPort } from '@ferretry/kernel/contract';
import { implementDaemon, definePlugin } from '@ferretry/kernel/manifest';
import { owner, testHost } from '@ferretry/kernel/testing';
import { nodeFs } from '../../../../../core/kernel/host/adapters/node-fs.ts';
import { platformRootPinner } from '../../../../../core/kernel/host/adapters/pinned/index.ts';
import { PinRegistry } from '../../../../../core/kernel/host/pins.ts';
import { rootsPortFor } from '../../../../../core/kernel/host/roots.ts';
import type { ProjectInfo } from '../../../contract/index.ts';
import { kernelFolders } from '../../../daemon/adapters/folders.ts';
import { implementProjects } from '../../../daemon/index.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

/** A host's `git`/`mkdir`, started as the kernel would (the caller's own environment is not borrowed beyond PATH). */
const hostSpawn: SpawnPort = {
  run: async (program, args, options) => {
    const child = Bun.spawn([program, ...args], {
      cwd: options?.cwd as string | undefined,
      env: { PATH: process.env.PATH ?? '', ...(options?.env as Record<string, string> | undefined) },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, signal: null, stdout, stderr };
  },
  runBytes: async () => {
    throw new Error('not used');
  },
  start: () => {
    throw new Error('not used');
  },
};

/** Real git in a fixture folder, with nothing from the machine's own configuration. */
const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const child = Bun.spawn(
    ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args],
    { cwd, env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } },
  );
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(' ')} failed`);
};

const repository = async (folder: string): Promise<string> => {
  await mkdir(folder, { recursive: true });
  await git(folder, 'init');
  await git(folder, 'commit', '--allow-empty', '-m', 'first');
  return folder;
};

async function world() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-discover-`));
  parents.push(parent);
  const home = join(parent, 'home');
  const fyHome = join(parent, 'fy-home');
  await mkdir(home, { recursive: true });
  await mkdir(join(fyHome, 'state'), { recursive: true });
  const pins = new PinRegistry(() => platformRootPinner());
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: fyHome, plugin: 'projects', worktrees: `${fyHome}-w` },
    ['imports'],
    () => undefined,
    { pins },
  );
  const kernel = { roots, paths: { home: () => home }, spawn: hostSpawn } as unknown as Pick<
    KernelPorts,
    'roots' | 'spawn' | 'paths'
  >;
  // Ferrets' stand-in: it offers `ferret.started` and holds the kernel's hook invoker, so a start is a real observe.
  const held: { observe?: (payload: FerretStartedPayload) => void } = {};
  const ferrets = implementDaemon(
    definePlugin({
      id: 'ferrets',
      title: 'Ferrets',
      version: '5.0.0',
      api: 5,
      core: true,
      kinds: [],
      hooks: { offers: [{ hook: FerretStarted }] },
    }),
    {
      build: ({ hooks }) => {
        held.observe = payload => hooks.observe(FerretStarted, payload);
        return {};
      },
    },
  );
  const host = await testHost({ plugins: [ferrets, implementProjects(kernelFolders(kernel))] });
  const start = async (folder: string) => {
    held.observe?.({ ferret: 'f1' as FerretId, name: 'worker', role: 'helper', folder, by: 'owner' });
    await host.settle();
  };
  const paths = async () =>
    (await host.request('GET', '/v1/projects', { as: owner() })).json<ProjectInfo[]>().map(project => project.path);
  return { parent, home, fyHome, start, paths };
}

describe('a ferret starting in a repository registers it, through the real start event (W-42)', () => {
  test('an ordinary repository under the home registers once, from the repository, a subfolder or a linked worktree', async () => {
    const w = await world();
    const alpha = await repository(join(w.home, 'work', 'alpha'));
    await mkdir(join(alpha, 'src'));
    await git(alpha, 'worktree', 'add', join(w.home, 'work', 'alpha-wt'));
    await w.start(alpha);
    await w.start(join(alpha, 'src'));
    await w.start(join(w.home, 'work', 'alpha-wt'));
    expect(await w.paths()).toEqual([alpha]);
  });

  test('the owner’s home, tracked by git, is not a project (MUST 1)', async () => {
    const w = await world();
    await repository(w.home);
    await w.start(w.home);
    await w.start(join(w.home, 'notes'));
    expect(await w.paths()).toEqual([]);
  });

  test('a repository inside the OS temp folder is not a project (MUST 1)', async () => {
    const w = await world();
    const scratch = await repository(join(w.parent, 'scratch', 'tool'));
    await w.start(scratch);
    expect(await w.paths()).toEqual([]);
  });

  test('a repository in Ferretry’s own home is not a project (MUST 1)', async () => {
    const w = await world();
    await w.start(await repository(join(w.fyHome, 'fleet', 'homes', 'a1', 'repo')));
    expect(await w.paths()).toEqual([]);
  });

  test('a repository in a harness home under the owner’s home is not a project (MUST 1)', async () => {
    const w = await world();
    await w.start(await repository(join(w.home, '.claude', 'plugins', 'cache')));
    expect(await w.paths()).toEqual([]);
  });

  test('a repository inside a .worktrees folder is not a project, while the linked worktree’s main checkout still is (MUST 1)', async () => {
    const w = await world();
    await w.start(await repository(join(w.home, 'work', '.worktrees', 'clone')));
    expect(await w.paths()).toEqual([]);
    const alpha = await repository(join(w.home, 'work', 'alpha'));
    await git(alpha, 'worktree', 'add', join(w.home, 'work', '.worktrees', 'alpha-wt'));
    await w.start(join(w.home, 'work', '.worktrees', 'alpha-wt'));
    expect(await w.paths()).toEqual([alpha]);
  });

  test('a bare repository literally named .git does not register its parent folder (MUST 2)', async () => {
    const w = await world();
    const parent = join(w.home, 'work', 'not-a-checkout');
    const bare = join(parent, '.git');
    await mkdir(bare, { recursive: true });
    await git(bare, 'init', '--bare');
    await w.start(bare);
    expect(await w.paths()).toEqual([]);
  });

  test('a ferret standing inside a real checkout’s own .git still registers that checkout (MUST 2 stays green)', async () => {
    const w = await world();
    const alpha = await repository(join(w.home, 'work', 'alpha'));
    await w.start(join(alpha, '.git'));
    expect(await w.paths()).toEqual([alpha]);
  });
});
