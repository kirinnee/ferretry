import { describe, it } from 'bun:test';
import should from 'should';
import {
  emptyManagedWorktreeState,
  findManagedWorktree,
  isRegistrySettled,
  isRemovalInterrupted,
  type ManagedWorktree,
  managedWorktreeDocument,
  type ManagedWorktreeIntent,
  type ManagedWorktreeRegistryState,
  parseManagedWorktreeRegistry,
  withManagedWorktree,
  withManagedWorktreeIntent,
  withoutManagedWorktreeIntent,
  withRemovalAbandoned,
  withRemovalStarted,
  withRemovedManagedWorktree,
  WorktreeError,
} from '../../../src/lib/worktrees/index.ts';

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

const intent = (overrides: Partial<ManagedWorktreeIntent> = {}): ManagedWorktreeIntent => ({
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
  ...overrides,
});

const state = (overrides: Partial<ManagedWorktreeRegistryState> = {}): ManagedWorktreeRegistryState => ({
  worktrees: [record()],
  intents: [],
  ...overrides,
});

const damage = (value: unknown): unknown => {
  try {
    parseManagedWorktreeRegistry(value);
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('the managed-worktree registry document', () => {
  it('should read back every durable fact a record carries', () => {
    // Act
    const actual = parseManagedWorktreeRegistry(managedWorktreeDocument(state()));

    // Assert — each of these is something Git cannot reconstruct
    should(actual.worktrees).have.length(1);
    should(actual.worktrees[0]).match({
      ownershipToken: 'ownership-token-0001',
      createdAt: '2026-08-04T00:00:00.000Z',
      initialHead: 'a'.repeat(40),
      branchPreexisted: false,
      commonDir: '/work/ferretry/.git',
      sourceCwd: '/work/ferretry/packages/cli',
      relativeCwd: 'packages/cli',
      ownerSessionId: 'sess-1',
    });
  });

  it('should read back a declared creation as an intent, not as a checkout', () => {
    // Act
    const actual = parseManagedWorktreeRegistry(managedWorktreeDocument(state({ intents: [intent()] })));

    // Assert
    should(actual.intents).have.length(1);
    should(actual.intents[0]).match({ path: '/managed/repo/feat-two', declaredAt: '2026-08-04T01:00:00.000Z' });
  });

  it('should treat an absent registry as a daemon that has made no checkouts', () => {
    // Act + Assert — missing is the initial state, and it is not damage
    should(parseManagedWorktreeRegistry(managedWorktreeDocument(emptyManagedWorktreeState()))).eql({
      worktrees: [],
      intents: [],
    });
  });

  it('should read a document written before intents existed as a settled registry', () => {
    // Act — the field is defaulted, so an older daemon's file is not damage
    const actual = parseManagedWorktreeRegistry({ version: 1, worktrees: [record()] });

    // Assert
    should(actual.intents).eql([]);
    should(isRegistrySettled(actual)).be.true();
  });

  it('should refuse a document it cannot interpret rather than reporting an empty fleet', () => {
    // Arrange — a truncated write, a hand edit, and a version this build does not serve
    const cases: unknown[] = [
      { version: 1, worktrees: [{ ...record(), branch: undefined }] },
      { version: 2, worktrees: [] },
      { worktrees: [] },
      { version: 1, worktrees: [{ ...record(), unexpected: true }] },
      { version: 1, worktrees: [], intents: [{ ...intent(), initialHead: undefined }] },
      'not a document at all',
    ];

    // Act + Assert
    for (const value of cases) {
      const thrown = damage(value);
      should(thrown).be.instanceof(WorktreeError);
      should((thrown as WorktreeError).code).equal('registry_damaged');
    }
  });

  it('should keep the empty relative cwd, because forking from the root is the ordinary case', () => {
    // Act
    const actual = parseManagedWorktreeRegistry(
      managedWorktreeDocument(state({ worktrees: [record({ relativeCwd: '' })] })),
    );

    // Assert
    should(actual.worktrees[0]?.relativeCwd).equal('');
  });
});

describe('filing and striking a record', () => {
  it('should replace an earlier record of the same path rather than holding two', () => {
    // Act
    const actual = withManagedWorktree(state(), record({ branch: 'feat/replaced' }));

    // Assert
    should(actual.worktrees).have.length(1);
    should(actual.worktrees[0]?.branch).equal('feat/replaced');
  });

  it('should keep a record for a different path beside it', () => {
    // Act
    const actual = withManagedWorktree(state(), record({ path: '/managed/repo/feat-two' }));

    // Assert
    should(actual.worktrees.map(entry => entry.path)).eql(['/managed/repo/feat-one', '/managed/repo/feat-two']);
  });

  it('should tombstone a removed checkout rather than forgetting it happened', () => {
    // Act
    const actual = withRemovedManagedWorktree(state(), '/managed/repo/feat-one', '2026-08-04T02:00:00.000Z');

    // Assert
    should(actual.worktrees[0]?.removedAt).equal('2026-08-04T02:00:00.000Z');
    should(actual.worktrees[0]?.branch).equal('feat/one');
  });

  it('should let a later checkout deliberately replace a tombstone at the same path', () => {
    // Arrange
    const tombstoned = withRemovedManagedWorktree(state(), record().path, '2026-08-04T02:00:00.000Z');
    const replacement = record({
      branch: 'feat/reused',
      ownershipToken: 'ownership-token-0003',
      createdAt: '2026-08-04T03:00:00.000Z',
    });

    // Act
    const actual = withManagedWorktree(tombstoned, replacement);

    // Assert — the tombstone is provenance, not a permanent reservation of an absent directory
    should(actual.worktrees).have.length(1);
    should(actual.worktrees[0]).match({
      branch: 'feat/reused',
      ownershipToken: 'ownership-token-0003',
      createdAt: '2026-08-04T03:00:00.000Z',
    });
    should(actual.worktrees[0]?.removedAt).be.undefined();
  });

  it('should leave a path the registry does not hold exactly as it was', () => {
    // Act
    const removed = withRemovedManagedWorktree(state(), '/managed/elsewhere', '2026-08-04T02:00:00.000Z');
    const started = withRemovalStarted(state(), '/managed/elsewhere', '2026-08-04T02:00:00.000Z');
    const abandoned = withRemovalAbandoned(state(), '/managed/elsewhere');

    // Assert
    should(removed.worktrees[0]?.removedAt).be.undefined();
    should(started.worktrees[0]?.removalStartedAt).be.undefined();
    should(abandoned.worktrees[0]).eql(record());
  });

  it('should find one record by path, and nothing for an unknown one', () => {
    // Act + Assert
    should(findManagedWorktree([record()], '/managed/repo/feat-one')?.branch).equal('feat/one');
    should(findManagedWorktree([record()], '/managed/nope')).be.undefined();
  });
});

describe('the two crash windows the registry has to survive', () => {
  it('should declare a creation before Git makes it, and replace it with the record afterwards', () => {
    // Arrange — the window a crash used to leave an unregistered checkout in
    const declared = withManagedWorktreeIntent(emptyManagedWorktreeState(), intent());

    // Act
    const finished = withManagedWorktree(declared, record({ path: intent().path, branch: 'feat/two' }));

    // Assert — filing the record retires the intent in the SAME write, so no path is ever both
    should(declared.intents).have.length(1);
    should(isRegistrySettled(declared)).be.false();
    should(finished.intents).be.empty();
    should(finished.worktrees.map(entry => entry.path)).eql([intent().path]);
    should(isRegistrySettled(finished)).be.true();
  });

  it('should replace a redeclared intent for one path rather than stacking two', () => {
    // Act
    const actual = withManagedWorktreeIntent(
      withManagedWorktreeIntent(emptyManagedWorktreeState(), intent()),
      intent({ branch: 'feat/renamed' }),
    );

    // Assert
    should(actual.intents).have.length(1);
    should(actual.intents[0]?.branch).equal('feat/renamed');
  });

  it('should drop an intent whose checkout was never made, and keep the others', () => {
    // Arrange
    const declared = withManagedWorktreeIntent(
      withManagedWorktreeIntent(emptyManagedWorktreeState(), intent()),
      intent({ path: '/managed/repo/feat-three' }),
    );

    // Act
    const actual = withoutManagedWorktreeIntent(declared, '/managed/repo/feat-two');

    // Assert
    should(actual.intents.map(entry => entry.path)).eql(['/managed/repo/feat-three']);
  });

  it('should stamp a removal before Git destroys anything, and settle it either way', () => {
    // Arrange — the window a crash used to leave a row nothing could ever heal
    const started = withRemovalStarted(state(), '/managed/repo/feat-one', '2026-08-04T02:00:00.000Z');

    // Act
    const confirmed = withRemovedManagedWorktree(started, '/managed/repo/feat-one', '2026-08-04T02:00:01.000Z');
    const abandoned = withRemovalAbandoned(started, '/managed/repo/feat-one');

    // Assert
    should(isRemovalInterrupted(started.worktrees[0]!)).be.true();
    should(isRegistrySettled(started)).be.false();
    should(isRemovalInterrupted(confirmed.worktrees[0]!)).be.false();
    should(abandoned.worktrees[0]).eql(record());
    should(isRegistrySettled(abandoned)).be.true();
  });

  it('should not read a finished removal as an interrupted one', () => {
    // Act + Assert — both stamps present means the answer is known
    should(
      isRemovalInterrupted(
        record({ removalStartedAt: '2026-08-04T02:00:00.000Z', removedAt: '2026-08-04T02:00:01.000Z' }),
      ),
    ).be.false();
    should(isRemovalInterrupted(record())).be.false();
  });
});
