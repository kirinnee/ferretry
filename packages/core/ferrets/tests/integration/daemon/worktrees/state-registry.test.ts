import { describe, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { WorktreesFile } from '../../../../contract/index.ts';
import { StateManagedWorktreeRegistry } from '../../../../daemon/adapters/worktrees/index.ts';
import {
  type ManagedWorktree,
  type ManagedWorktreeIntent,
  WorktreeError,
  withManagedWorktree,
  withManagedWorktreeIntent,
  withRemovalStarted,
  withRemovedManagedWorktree,
} from '../../../../daemon/lib/worktrees/index.ts';

const record = (overrides: Partial<ManagedWorktree> = {}): ManagedWorktree => ({
  version: 1,
  path: '/managed/repo/feat-one',
  branch: 'feat/one',
  repositoryRoot: '/work/ferretry',
  commonDir: '/work/ferretry/.git',
  gitDir: '/work/ferretry/.git/worktrees/feat-one',
  ownershipToken: 'ownership-token-0001',
  createdAt: '2026-08-04T00:00:00.000Z',
  initialHead: 'a'.repeat(40),
  branchPreexisted: false,
  sourceCwd: '/work/ferretry/packages/cli',
  relativeCwd: 'packages/cli',
  ownerSessionId: 'sess-1',
  ...overrides,
});

const intent: ManagedWorktreeIntent = {
  version: 1,
  path: '/managed/repo/feat-two',
  branch: 'feat/two',
  repositoryRoot: '/work/ferretry',
  commonDir: '/work/ferretry/.git',
  ownershipToken: 'ownership-token-0002',
  declaredAt: '2026-08-04T01:00:00.000Z',
  initialHead: 'b'.repeat(40),
  branchPreexisted: false,
  sourceCwd: '/work/ferretry',
  relativeCwd: '',
};

/** A registry over the kernel's state port, as Ferrets' build makes one (`state/ferrets/worktrees.json`). */
function registryAt(_label: string): { registry: StateManagedWorktreeRegistry; folder: MemoryStateFolder } {
  const folder = new MemoryStateFolder();
  return { registry: new StateManagedWorktreeRegistry(folder.port([WorktreesFile])), folder };
}

const error = async (operation: Promise<unknown>): Promise<unknown> =>
  await operation.then(() => undefined).catch((thrown: unknown) => thrown);

describe('the state-backed managed-worktree registry', () => {
  it('should read an absent registry as a daemon that has made no checkouts', async () => {
    // Arrange
    const { registry } = registryAt('wt-registry-missing');

    // Act
    const actual = await registry.read();

    // Assert — missing is the initial state; nothing is created just by looking
    should(actual).eql({ worktrees: [], intents: [] });
  });

  it('should round-trip every durable fact, including a declared creation', async () => {
    // Arrange
    const { registry } = registryAt('wt-registry-roundtrip');

    // Act
    await registry.write(state => withManagedWorktree(state, record()));
    await registry.write(state => withManagedWorktreeIntent(state, intent));
    const actual = await registry.read();

    // Assert
    should(actual.worktrees[0]).eql(record());
    should(actual.intents[0]).eql(intent);
  });

  it('should apply concurrent changes one after another rather than losing one', async () => {
    // Arrange — a read-modify-write in each caller is exactly how an update goes missing
    const { registry } = registryAt('wt-registry-serial');

    // Act
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        registry.write(state => withManagedWorktree(state, record({ path: `/managed/repo/feat-${index}` }))),
      ),
    );

    // Assert
    should((await registry.read()).worktrees).have.length(8);
  });

  it('should carry a removal stamp and its tombstone through the file', async () => {
    // Arrange
    const { registry } = registryAt('wt-registry-stamps');
    await registry.write(state => withManagedWorktree(state, record()));

    // Act
    await registry.write(state => withRemovalStarted(state, record().path, '2026-08-04T02:00:00.000Z'));
    const stamped = await registry.read();
    await registry.write(state => withRemovedManagedWorktree(state, record().path, '2026-08-04T02:00:01.000Z'));
    const settled = await registry.read();

    // Assert — the stamp is what a crashed removal leaves behind for the next read to settle
    should(stamped.worktrees[0]?.removalStartedAt).equal('2026-08-04T02:00:00.000Z');
    should(stamped.worktrees[0]?.removedAt).be.undefined();
    should(settled.worktrees[0]?.removedAt).equal('2026-08-04T02:00:01.000Z');
  });

  it('should refuse bytes that are not JSON rather than reporting an empty fleet', async () => {
    // Arrange — a truncated write is the realistic shape of this
    const { registry, folder } = registryAt('wt-registry-truncated');
    await registry.write(state => withManagedWorktree(state, record()));
    const complete = folder.raw(WorktreesFile) ?? '';
    folder.plant(WorktreesFile, complete.slice(0, complete.length / 2));

    // Act
    const actual = await error(registry.read());

    // Assert
    should(actual).be.instanceof(WorktreeError);
    should((actual as WorktreeError).code).equal('registry_damaged');
    should((actual as WorktreeError).message).containEql('damaged');
  });

  it('should refuse readable JSON that is not a registry this build can serve', async () => {
    // Arrange
    const { registry, folder } = registryAt('wt-registry-foreign');
    await registry.write(state => withManagedWorktree(state, record()));
    folder.plant(WorktreesFile, JSON.stringify({ format: 99, worktrees: [] }));

    // Act
    const actual = await error(registry.read());

    // Assert
    should((actual as WorktreeError).code).equal('registry_damaged');
    should((actual as WorktreeError).message).containEql('damaged');
  });

});

describe('the managed-worktree document', () => {
  it('should be stored at format 1 with no intents default: a document without intents is damaged, not converted', async () => {
    // Arrange
    const { registry, folder } = registryAt('wt-registry-format');
    await registry.write(state => withManagedWorktree(state, record()));

    // Act
    const stored = JSON.parse(folder.raw(WorktreesFile) ?? '{}') as { format?: number };
    folder.plant(WorktreesFile, JSON.stringify({ format: 1, worktrees: [] }));
    const actual = await error(registry.read());

    // Assert
    should(stored.format).equal(1);
    should((actual as WorktreeError).code).equal('registry_damaged');
  });
});
