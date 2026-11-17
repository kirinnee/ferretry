import { afterAll, describe, it } from 'bun:test';
import { lstat, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { fixedClock } from '@ferretry/kernel/testing';
import { buildWorktrees } from '../../../../daemon/modules/worktrees.ts';
import { KernelGitRunner } from '../../../../daemon/adapters/git/runner.ts';
import {
  GitWorktreeGateway,
  ManagedWorktreeAdapter,
  WorktreeOperationQueue,
} from '../../../../daemon/adapters/worktrees/index.ts';
import { TestWorktreeClock } from '../../../support/daemon/host-io.ts';
import { composeWorktreeWorld as compose } from '../../../support/daemon/worktree-world.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * COMPOSED (v4 parity `fy worktree fork`): the managed-worktree module built exactly as Ferrets' `build` builds it,
 * over the kernel's REAL roots (`worktrees` and the ferret's `work` root) on a real disk and real Git. Before the host
 * IO was wired, `buildWorktrees` never got an `io` and every fork said "this daemon has no managed worktree root".
 */

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

  it('should read the kind of a root’s own folder with stat, and of anything inside it without following a link', async () => {
    const { repository, io } = await compose('type-kinds');
    if (io === undefined) throw new Error('the worktrees root named no folder');
    const inside = path.join(io.managedRoot, 'inside');
    await mkdir(inside);
    await symlink(inside, path.join(io.managedRoot, 'link'));

    should(await io.fileSystem.type(io.managedRoot)).equal('directory');
    should(await io.fileSystem.type(repository.root)).equal('directory');
    should(await io.fileSystem.type(inside)).equal('directory');
    should(await io.fileSystem.type(path.join(io.managedRoot, 'link'))).equal('symlink');
    should(await io.fileSystem.type(path.join(io.managedRoot, 'nothing-here'))).equal('missing');
  });

  it('should read back text written under the managed root, through that root', async () => {
    const { io } = await compose('read-text');
    if (io === undefined) throw new Error('the worktrees root named no folder');
    const target = path.join(io.managedRoot, 'owner');

    await io.fileSystem.writeText(target, 'ownership-token-0001\n', 0o600);

    should(await io.fileSystem.readText(target)).equal('ownership-token-0001\n');
  });
});
