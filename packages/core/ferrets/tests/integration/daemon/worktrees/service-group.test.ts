import { afterAll, describe, it } from 'bun:test';
import path from 'node:path';
import should from 'should';
import { PosixSessionRootPinner, ProcfsSessionRootPinner } from '../../../support/daemon/session-filesystem/index.ts';
import {
  GitWorktreeGateway,
  ManagedWorktreeAdapter,
  WorktreeOperationQueue,
} from '../../../../daemon/adapters/worktrees/index.ts';
import type { WorktreeError } from '../../../../daemon/lib/worktrees/index.ts';
import type { CreateManagedWorktreeInput } from '../../../../daemon/lib/worktrees/types.ts';
import { cleanupTempDirectories, tempDirectory, tempRepository } from '../support/repository.ts';
import { NodeWorktreeFileSystem, TestWorktreeClock, testGitRunner } from '../../../support/daemon/host-io.ts';

/** Creating a managed worktree under a caller-chosen group folder: `<root>/<group>/<repo>-<hash>/<branch>-<hash>-<id>`. */

const files = new NodeWorktreeFileSystem();
const clock = new TestWorktreeClock();

const adapter = (): ManagedWorktreeAdapter =>
  new ManagedWorktreeAdapter(
    new GitWorktreeGateway(testGitRunner(), files, clock),
    files,
    clock,
    new WorktreeOperationQueue(),
    process.platform === 'linux' ? new ProcfsSessionRootPinner() : new PosixSessionRootPinner(),
  );

async function request(label: string, overrides: Partial<CreateManagedWorktreeInput> = {}) {
  const repository = await tempRepository(label);
  const managedRoot = path.join(await tempDirectory(`${label}-managed`), 'worktrees');
  const input: CreateManagedWorktreeInput = {
    sourceCwd: repository.root,
    branch: 'feature/managed',
    sessionId: 'session-1',
    ownershipToken: 'ownership-token-0001',
    managedRoot,
    ...overrides,
  };
  return { input, managedRoot };
}

describe('ManagedWorktreeAdapter creation under a group', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  it('should file the checkout at <root>/<group>/<repo>-<hash>/<branch>-<hash>-<id>', async () => {
    // Arrange
    const { input, managedRoot } = await request('svc-group', { group: 'alpha-1a2b3c4d' });

    // Act
    const actual = await adapter().create(input);

    // Assert
    const relative = path.relative(await files.realPath(managedRoot), actual.managed.path).split(path.sep);
    should(relative).have.length(3);
    should(relative[0]).equal('alpha-1a2b3c4d');
    should(relative[1]).match(/^[a-zA-Z0-9._-]+-[0-9a-f]{10}$/);
    should(relative[2]).match(/^feature-managed-[0-9a-f]{8}-session-1$/);
    should(await files.type(actual.managed.path)).equal('directory');
  });

  it('should keep the group folder private to the daemon', async () => {
    // Arrange
    const { input, managedRoot } = await request('svc-group-mode', { group: 'alpha-1a2b3c4d' });

    // Act
    await adapter().create(input);

    // Assert
    const { statSync } = await import('node:fs');
    should(statSync(path.join(managedRoot, 'alpha-1a2b3c4d')).mode & 0o777).equal(0o700);
  });

  it('should leave a checkout with no group exactly where it was filed before', async () => {
    // Arrange
    const { input, managedRoot } = await request('svc-group-none');

    // Act
    const actual = await adapter().create(input);

    // Assert
    should(path.dirname(path.dirname(actual.managed.path))).equal(await files.realPath(managedRoot));
  });

  it('should put two checkouts of one repository in one group side by side', async () => {
    // Arrange
    const { input } = await request('svc-group-pair', { group: 'alpha-1a2b3c4d' });
    const first = await adapter().create(input);

    // Act
    const second = await adapter().create({ ...input, branch: 'feature/other', sessionId: 'session-2' });

    // Assert
    should(path.dirname(second.managed.path)).equal(path.dirname(first.managed.path));
  });

  it.each([
    ['the parent folder', '..'],
    ['the current folder', '.'],
    ['empty', ''],
    ['a nested path', 'a/b'],
    ['an absolute path', '/tmp/escape'],
    ['a parent hop inside', 'a/../../b'],
    ['a control character', 'a\u0000b'],
    ['a hidden folder', '.hidden'],
    ['overlong', 'x'.repeat(65)],
  ])('should refuse a group that is %s, before anything is made', async (_label, group) => {
    // Arrange
    const { input, managedRoot } = await request('svc-group-bad', { group });

    // Act
    const actual = await adapter()
      .create(input)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    // Assert
    should((actual as WorktreeError | undefined)?.code).equal('invalid_group');
    should(await files.type(managedRoot)).equal('missing');
  });
});
