import { afterAll, describe, it } from 'bun:test';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { FileManagedWorktreeRegistry } from '../../../src/adapters/worktrees/index.ts';
import {
  type ManagedWorktree,
  type ManagedWorktreeIntent,
  WorktreeError,
  withManagedWorktree,
  withManagedWorktreeIntent,
  withRemovalStarted,
  withRemovedManagedWorktree,
} from '../../../src/lib/worktrees/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

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

async function registryAt(label: string): Promise<{ registry: FileManagedWorktreeRegistry; file: string }> {
  const root = await tempDirectory(label);
  const file = path.join(root, 'state', 'worktrees.json');
  return { registry: new FileManagedWorktreeRegistry(file), file };
}

const error = async (operation: Promise<unknown>): Promise<unknown> =>
  await operation.then(() => undefined).catch((thrown: unknown) => thrown);

describe('the file-backed managed-worktree registry', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  it('should read an absent registry as a daemon that has made no checkouts', async () => {
    // Arrange
    const { registry } = await registryAt('wt-registry-missing');

    // Act
    const actual = await registry.read();

    // Assert — missing is the initial state; nothing is created just by looking
    should(actual).eql({ worktrees: [], intents: [] });
  });

  it('should create its directory owner-only and write the document owner-readable', async () => {
    // Arrange
    const { registry, file } = await registryAt('wt-registry-modes');

    // Act
    await registry.write(state => withManagedWorktree(state, record()));

    // Assert
    should((await stat(path.dirname(file))).mode & 0o777).equal(0o700);
    should((await stat(file)).mode & 0o777).equal(0o600);
  });

  it('should round-trip every durable fact, including a declared creation', async () => {
    // Arrange
    const { registry } = await registryAt('wt-registry-roundtrip');

    // Act
    await registry.write(state => withManagedWorktree(state, record()));
    await registry.write(state => withManagedWorktreeIntent(state, intent));
    const actual = await registry.read();

    // Assert
    should(actual.worktrees[0]).eql(record());
    should(actual.intents[0]).eql(intent);
  });

  it('should leave no temporary file behind, because the save is a rename', async () => {
    // Arrange
    const { registry, file } = await registryAt('wt-registry-atomic');

    // Act
    await registry.write(state => withManagedWorktree(state, record()));
    const entries = [...new Bun.Glob('.*').scanSync({ cwd: path.dirname(file), onlyFiles: true, dot: true })];

    // Assert
    should(entries).be.empty();
    should(JSON.parse(await readFile(file, 'utf8'))).match({ version: 1 });
  });

  it('should apply concurrent changes one after another rather than losing one', async () => {
    // Arrange — a read-modify-write in each caller is exactly how an update goes missing
    const { registry } = await registryAt('wt-registry-serial');

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
    const { registry } = await registryAt('wt-registry-stamps');
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
    const { registry, file } = await registryAt('wt-registry-truncated');
    await registry.write(state => withManagedWorktree(state, record()));
    const complete = await readFile(file, 'utf8');
    await writeFile(file, complete.slice(0, complete.length / 2));

    // Act
    const actual = await error(registry.read());

    // Assert
    should(actual).be.instanceof(WorktreeError);
    should((actual as WorktreeError).code).equal('registry_damaged');
    should((actual as WorktreeError).message).containEql('not readable JSON');
  });

  it('should refuse readable JSON that is not a registry this build can serve', async () => {
    // Arrange
    const { registry, file } = await registryAt('wt-registry-foreign');
    await registry.write(state => withManagedWorktree(state, record()));
    await writeFile(file, JSON.stringify({ version: 99, worktrees: [] }));

    // Act
    const actual = await error(registry.read());

    // Assert
    should((actual as WorktreeError).code).equal('registry_damaged');
    should((actual as WorktreeError).message).containEql('damaged');
  });

  it('should let a read failure that is not absence propagate rather than reading as empty', async () => {
    // Arrange
    const { registry, file } = await registryAt('wt-registry-unreadable');
    await registry.write(state => withManagedWorktree(state, record()));
    await chmod(file, 0o000);

    // Act
    const actual = await error(registry.read());

    // Assert — an unreadable registry is not a daemon that has made no worktrees
    await chmod(file, 0o600);
    should(actual).be.instanceof(Error);
    should(actual).not.be.instanceof(WorktreeError);
  });
});
