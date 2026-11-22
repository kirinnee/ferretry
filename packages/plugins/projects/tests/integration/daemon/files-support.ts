import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { KernelPorts } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { bunSpawn } from '../../../../../core/kernel/host/adapters/process.ts';
import { nodeFs } from '../../../../../core/kernel/host/adapters/node-fs.ts';
import { platformRootPinner } from '../../../../../core/kernel/host/adapters/pinned/index.ts';
import { restrictSpawn } from '../../../../../core/kernel/host/permissions.ts';
import { PinRegistry } from '../../../../../core/kernel/host/pins.ts';
import { rootsPortFor } from '../../../../../core/kernel/host/roots.ts';
import { kernelBrowser } from '../../../daemon/features/folders/adapter.ts';
import {
  buildProjectIndex,
  type ProjectIndexDeps,
  type ProjectIndexLimits,
} from '../../../daemon/features/files/build.ts';
import { kernelGit, kernelPins } from '../../../daemon/features/files/pins.ts';

const parents: string[] = [];

/** Removes every temp tree the tests made. */
export async function cleanUp(): Promise<void> {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
}

/** Runs real `git` in `cwd` with a closed environment of its own (the test's identity, no ambient config). */
export function git(cwd: string, home: string, ...args: readonly string[]): string {
  const run = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      GIT_CONFIG_GLOBAL: join(home, '.gitconfig-test'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

/** Writes files (and the folders above them) from a map of relative path to text. */
export async function put(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  }
}

/**
 * A fake machine on a temp disk: a user home holding `work/`, the kernel's REAL `imports` root over it, and real `git` run
 * as a kernel child with that home as its `HOME` (so the owner's global exclude file is the test's own).
 */
export async function world(limits?: ProjectIndexLimits, overrides: Partial<ProjectIndexDeps> = {}) {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-files-`));
  parents.push(parent);
  const user = join(parent, 'user');
  const project = join(user, 'work');
  await mkdir(project, { recursive: true });
  await mkdir(join(parent, 'fy-home', 'state'), { recursive: true });
  const pins = new PinRegistry(() => platformRootPinner());
  const roots = rootsPortFor(
    nodeFs(() => crypto.randomUUID()),
    { home: join(parent, 'fy-home'), plugin: 'projects', worktrees: `${join(parent, 'fy-home')}-w` },
    ['imports'],
    () => undefined,
    { pins },
  );
  const spawn = restrictSpawn(
    'projects',
    ['git'],
    bunSpawn({ PATH: process.env.PATH ?? '', HOME: user }),
    undefined,
    pins,
  );
  const clock = {
    after: (delay: number, fn: () => void) => {
      const timer = setTimeout(fn, Number(delay));
      return () => clearTimeout(timer);
    },
  };
  const kernel = { roots, paths: { home: () => user }, spawn, clock } as unknown as Pick<
    KernelPorts,
    'roots' | 'paths' | 'spawn' | 'clock'
  >;
  let tick = 0;
  const deps: ProjectIndexDeps = {
    pins: kernelPins(kernel, kernelBrowser(kernel)),
    git: kernelGit(kernel),
    nowMs: () => Date.now(),
    instant: () => new Date(Date.UTC(2026, 10, 22, 0, 0, tick++)).toISOString() as Instant,
    ...(limits === undefined ? {} : { limits }),
    ...overrides,
  };
  return {
    parent,
    user,
    project,
    kernel,
    deps,
    build: (path: string = project) => buildProjectIndex(path, deps),
  };
}
