import { afterAll, describe, it } from 'bun:test';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import type { FencedPath, FerretId, SpawnBytesResult } from '@ferretry/kernel/contract';
import { fixedClock } from '@ferretry/kernel/testing';
import { PinRegistry } from '../../../../../kernel/host/pins.ts';
import { platformRootPinner } from '../../../../../kernel/host/adapters/pinned/index.ts';
import { nodeFs } from '../../../../../kernel/host/adapters/node-fs.ts';
import { ensureWorktreesBase, rootsPortFor } from '../../../../../kernel/host/roots.ts';
import { buildWorktrees } from '../../../../daemon/modules/worktrees.ts';
import { KernelGitRunner } from '../../../../daemon/adapters/git/runner.ts';
import {
  GitWorktreeGateway,
  ManagedWorktreeAdapter,
  WorktreeOperationQueue,
} from '../../../../daemon/adapters/worktrees/index.ts';
import { TestWorktreeClock } from '../../../support/daemon/host-io.ts';
import { createKernelWorktreeHostIo } from '../../../../daemon/adapters/worktrees/kernel-host-io.ts';
import { cleanupTempDirectories, tempDirectory, tempRepository } from '../support/repository.ts';

/**
 * COMPOSED (v4 parity `fy worktree fork`): the managed-worktree module built exactly as Ferrets' `build` builds it,
 * over the kernel's REAL roots (`worktrees` and the ferret's `work` root) on a real disk and real Git. Before the host
 * IO was wired, `buildWorktrees` never got an `io` and every fork said "this daemon has no managed worktree root".
 */

const FERRET = 'F1' as FerretId;

/** `kernel.spawn.runBytes` for Git over a real child: a fenced folder by string, a pin by its install. */
const pins = new PinRegistry(() => platformRootPinner());

const spawn = {
  runBytes: async (
    program: string,
    args: readonly string[],
    options: {
      readonly cwd?: FencedPath | { install(): () => void };
      readonly env?: Readonly<Record<string, string>>;
      readonly stdin?: string | Uint8Array;
    },
  ): Promise<SpawnBytesResult> => {
    const cwd = options.cwd;
    const alias = typeof cwd === 'object' ? pins.lookup('ferrets', cwd as never)?.alias : undefined;
    const release = typeof cwd === 'object' ? cwd.install() : undefined;
    let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
    try {
      child = Bun.spawn([program, ...args], {
        cwd: typeof cwd === 'string' ? cwd : (alias ?? '.'),
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...options.env },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } finally {
      release?.();
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      exitCode,
      stdout: new Uint8Array(stdout),
      stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    };
  },
};

async function compose(label: string) {
  const parent = await tempDirectory(`${label}-home`);
  const repository = await tempRepository(`${label}-repo`);
  const folders = {
    folderOf: () => repository.root as FencedPath,
    check: (_ferret: FerretId, candidate: string) =>
      candidate.startsWith(repository.root)
        ? ({ ok: true, value: candidate as FencedPath } as const)
        : ({ ok: false, error: 'outside' } as const),
  };
  await mkdir(path.join(parent, 'home', 'state'), { recursive: true });
  const layout = { home: path.join(parent, 'home'), plugin: 'ferrets', worktrees: path.join(parent, 'home-worktrees') };
  // The host makes the managed folder before the plugin is built.
  should(
    await ensureWorktreesBase(
      nodeFs(() => 'x'),
      layout,
      ['worktrees'],
    ),
  ).be.undefined();
  const roots = rootsPortFor(
    nodeFs(() => 'x'),
    layout,
    ['worktrees', 'work'],
    () => folders,
    { pins },
  );
  const io = createKernelWorktreeHostIo({
    worktrees: roots.root('worktrees'),
    work: ferret => roots.root('work', { ferret }),
    ferrets: () => [{ id: FERRET, folder: repository.root }],
    spawn,
  });
  return { parent, repository, io };
}

describe('createKernelWorktreeHostIo', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  it('should name the worktrees root as the managed folder', async () => {
    const { parent, io } = await compose('names-root');

    should(io?.managedRoot).equal(path.join(parent, 'home-worktrees'));
  });

  it('should let the managed-worktree module create a checkout of a ferret folder under the managed root', async () => {
    // Arrange — the module exactly as Ferrets' build makes it, with the host IO.
    const { repository, io } = await compose('create');
    if (io === undefined) throw new Error('the worktrees root named no folder');
    const built = buildWorktrees({
      state: undefined as never,
      clock: fixedClock('2026-11-14T00:00:00.000Z'),
      io,
      sessions: async () => [],
      terminalRoots: async () => undefined,
      newId: () => 'ownership-token-0001',
    });
    const clock = new TestWorktreeClock();
    const adapter = new ManagedWorktreeAdapter(
      new GitWorktreeGateway(new KernelGitRunner(io.git), io.fileSystem, clock),
      io.fileSystem,
      clock,
      new WorktreeOperationQueue(),
      io.pinner,
    );

    // Act
    const created = await adapter.create({
      sourceCwd: repository.root,
      branch: 'feature/fork',
      sessionId: 'session-1',
      ownershipToken: 'ownership-token-0001',
      managedRoot: io.managedRoot,
    });

    // Assert
    should(created.managed.path.startsWith(io.managedRoot)).be.true();
    should((await lstat(created.managed.path)).isDirectory()).be.true();
    should(created.managed.initialHead).equal(repository.head);
    should(built.managedRoot).equal(io.managedRoot);
  });

  it('should refuse a folder no ferret stands in, in words', async () => {
    const { io } = await compose('outside');
    const other = await tempDirectory('outside-other');

    const thrown = await io?.fileSystem.type(other).then(
      () => undefined,
      (error: unknown) => error,
    );

    should(String(thrown)).containEql('may not reach');
  });
});
