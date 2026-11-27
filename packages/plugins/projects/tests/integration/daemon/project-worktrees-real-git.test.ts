/**
 * The project's branches and worktrees over REAL Git and Projects' REAL register and list handlers (a real `git rev-parse`
 * records the project's common directory, and the record carries no `repos` until a scan keeps some). Synthetic trees only:
 * one main checkout with two linked worktrees, and a project that IS one of the linked checkouts. The page's own inventory
 * (`worktreeSources`) decides which common directory to ask Ferrets about; Ferrets' list is keyed by that directory and reads
 * it with Git, so here Git itself is asked the same question (`git --git-dir=<commonDir> worktree list`): a folder that is not a
 * repository's common directory, such as a linked checkout's own `.git` FILE, is refused by it exactly as Ferrets refuses it.
 * (Ferrets' own handler is not importable here: a plugin reaches another package only through its contract.)
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { KernelPorts, SpawnPort } from '@ferretry/kernel/contract';
import { owner, testHost } from '@ferretry/kernel/testing';
import { nodeFs } from '../../../../../core/kernel/host/adapters/node-fs.ts';
import { platformRootPinner } from '../../../../../core/kernel/host/adapters/pinned/index.ts';
import { PinRegistry } from '../../../../../core/kernel/host/pins.ts';
import { rootsPortFor } from '../../../../../core/kernel/host/roots.ts';
import type { ProjectInfo } from '../../../contract/index.ts';
import { worktreeSources } from '../../../app/features/worktrees/worktrees-api.ts';
import { kernelFolders } from '../../../daemon/adapters/folders.ts';
import { implementProjects } from '../../../daemon/index.ts';

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

const created: string[] = [];
const tempDirectory = async (label: string): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), `fy-${label}-`)));
  created.push(directory);
  return directory;
};

/** Git for fixture setup and for the oracle: nothing of the machine's own configuration. */
const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${err.trim()}`);
  return out;
};

async function world() {
  const main = `${await tempDirectory('vb3-main')}/repo`;
  await Bun.write(join(main, 'README.md'), '# fixture\n');
  await git(dirname(main), 'init', '-b', 'main', '--quiet', main);
  await git(main, 'add', 'README.md');
  await git(main, 'commit', '--quiet', '-m', 'chore: seed');
  const linked = async (branch: string): Promise<string> => {
    const folder = `${await tempDirectory('vb3-wt')}/checkout`;
    await git(main, 'worktree', 'add', '-b', branch, folder);
    return folder;
  };
  const featA = await linked('feat/a');
  const featB = await linked('feat/b');
  const fyHome = await tempDirectory('vb3-fyhome');
  const pins = new PinRegistry(() => platformRootPinner());
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: fyHome, plugin: 'projects', worktrees: `${fyHome}-w` },
    ['imports'],
    () => undefined,
    { pins },
  );
  const kernel = { roots, paths: { home: () => dirname(main) }, spawn: hostSpawn } as unknown as Pick<
    KernelPorts,
    'roots' | 'spawn' | 'paths'
  >;
  const host = await testHost({ plugins: [implementProjects(kernelFolders(kernel))] });
  const register = async (path: string): Promise<ProjectInfo> =>
    (await host.request('POST', '/v1/projects', { body: { kind: 'existing-folder', path }, as: owner() })).json();
  const listed = async (id: string): Promise<ProjectInfo> => {
    const all = (await host.request('GET', '/v1/projects', { as: owner() })).json<ProjectInfo[]>();
    return all.find(project => project.id === id) as ProjectInfo;
  };
  return { main, featA, featB, register, listed };
}

/** The branches Git lists for one common directory; a folder Git cannot read as one throws, as Ferrets answers 422. */
const branchesIn = async (commonDir: string): Promise<string[]> =>
  (await git(dirname(commonDir), `--git-dir=${commonDir}`, 'worktree', 'list', '--porcelain'))
    .split('\n')
    .filter(line => line.startsWith('branch refs/heads/'))
    .map(line => line.slice('branch refs/heads/'.length));

const branchesOf = async (project: ProjectInfo): Promise<string[]> =>
  (await Promise.all(worktreeSources(project).map(source => branchesIn(source.commonDir)))).flat().sort();

afterAll(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('the project worktree inventory over real Git (V-B3 round 1)', () => {
  test('MUST 1: a project record with `repos` absent still lists the main checkout and both linked worktrees', async () => {
    const w = await world();
    const registered = await w.register(w.main);
    const project = await w.listed(registered.id);
    expect(project.repos).toBeUndefined();
    expect(project.git?.commonDirectory).toBe(`${w.main}/.git`);
    expect(await branchesOf(project)).toEqual(['feat/a', 'feat/b', 'main']);
  });

  test('MUST 2: a project that IS a linked checkout lists its main checkout and the other linked branches', async () => {
    const w = await world();
    const registered = await w.register(w.featA);
    const project = await w.listed(registered.id);
    expect(project.git?.commonDirectory).toBe(`${w.main}/.git`);
    expect(await branchesOf(project)).toEqual(['feat/a', 'feat/b', 'main']);
  });

  test('MUST 2: the same linked project, once a scan has kept `.` as its repository, still asks the right common directory', async () => {
    const w = await world();
    const registered = await w.register(w.featB);
    const project = { ...(await w.listed(registered.id)), repos: [{ path: '.' }] };
    expect(worktreeSources(project).map(source => source.commonDir)).toEqual([`${w.main}/.git`]);
    expect(await branchesOf(project)).toEqual(['feat/a', 'feat/b', 'main']);
  });
});
