import { describe, it } from 'bun:test';
import type { ManagedWorktreeView, ProjectInfo, WorktreeRemovalRequest } from '@ferretry/protocol';
import should from 'should';
import {
  type CheckManagedWorktreeRemovalInput,
  type CreatedManagedWorktree,
  type CreateManagedWorktreeInput,
  isWorktreeSessionActive,
  type ManagedWorktree,
  type ManagedWorktreeInspection,
  type ManagedWorktreeAdoption,
  type ManagedWorktreeIntent,
  type ManagedWorktreeOperations,
  type ManagedWorktreePresence,
  type ManagedWorktreeRegistryState,
  ManagedWorktreeService,
  managedWorktreeRemovalContext,
  orderManagedWorktreeViews,
  type RemoveManagedWorktreeInput,
  type RemovedManagedWorktree,
  type WorktreeSessionFact,
  WorktreeError,
  WorktreeRemovalRefusal,
} from '../../../src/lib/worktrees/index.ts';

const MANAGED_ROOT = '/managed';

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

const session = (overrides: Partial<WorktreeSessionFact> = {}): WorktreeSessionFact => ({
  id: 'sess-1',
  cwd: '/work/ferretry',
  status: 'running',
  ...overrides,
});

const PROJECT: ProjectInfo = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-08-04T00:00:00.000Z',
  git: { commonDirectory: '/work/ferretry/.git' },
};

const inspection = (overrides: Partial<ManagedWorktreeInspection> = {}): ManagedWorktreeInspection => ({
  live: { detached: false, head: 'b'.repeat(40), branch: 'feat/one', undetermined: [] },
  decision: { removable: true, path: '/managed/repo/feat-one', branch: 'feat/one', blockers: [] },
  ...overrides,
});

/** Records what the domain asked Git to do, and answers with fixed evidence. */
class RecordingOperations implements ManagedWorktreeOperations {
  readonly examined: CheckManagedWorktreeRemovalInput[] = [];
  readonly removals: RemoveManagedWorktreeInput[] = [];
  readonly creations: CreateManagedWorktreeInput[] = [];
  readonly adopted: ManagedWorktreeIntent[] = [];
  readonly probed: string[] = [];

  constructor(
    private readonly answers: {
      readonly inspection?: ManagedWorktreeInspection;
      readonly created?: ManagedWorktree;
      readonly removed?: RemovedManagedWorktree;
      readonly removalFails?: Error;
      readonly adoption?: ManagedWorktreeAdoption;
      readonly presence?: ManagedWorktreePresence;
      readonly existsFails?: Error;
      readonly afterPlanned?: (input: CreateManagedWorktreeInput) => Promise<void>;
      readonly beforeRemove?: (input: RemoveManagedWorktreeInput) => Promise<void>;
    } = {},
  ) {}

  async create(input: CreateManagedWorktreeInput): Promise<CreatedManagedWorktree> {
    this.creations.push(input);
    const managed = this.answers.created ?? record({ ownerSessionId: input.ownerSessionId });
    await input.onPlanned?.({
      sourceCwd: input.sourceCwd,
      path: managed.path,
      sessionCwd: `${managed.path}/${managed.relativeCwd}`,
      relativeCwd: managed.relativeCwd,
      branch: managed.branch,
      repositoryRoot: managed.repositoryRoot,
      commonDir: managed.commonDir,
      ownershipToken: input.ownershipToken,
      branchPreexisted: managed.branchPreexisted,
      startOid: managed.initialHead,
    });
    await this.answers.afterPlanned?.(input);
    return {
      cwd: `${managed.path}/${managed.relativeCwd}`,
      checkout: { repo: true, kind: 'linked_worktree', observedAt: '2026-08-04T00:00:00.000Z' },
      managed,
    };
  }

  async examine(input: CheckManagedWorktreeRemovalInput): Promise<ManagedWorktreeInspection> {
    this.examined.push(input);
    return this.answers.inspection ?? inspection();
  }

  async remove(input: RemoveManagedWorktreeInput): Promise<RemovedManagedWorktree> {
    this.removals.push(input);
    await this.answers.beforeRemove?.(input);
    if (this.answers.removalFails) throw this.answers.removalFails;
    return (
      this.answers.removed ?? {
        path: input.managed.path,
        branch: input.managed.branch,
        branchRetained: true,
        branchBlockers: [],
        removedAt: '2026-08-04T02:00:00.000Z',
      }
    );
  }

  async adopt(intent: ManagedWorktreeIntent): Promise<ManagedWorktreeAdoption> {
    this.adopted.push(intent);
    return this.answers.adoption ?? { kind: 'absent' };
  }

  async presence(entry: ManagedWorktree): Promise<ManagedWorktreePresence> {
    this.probed.push(entry.path);
    if (this.answers.existsFails) throw this.answers.existsFails;
    return this.answers.presence ?? { kind: 'absent' };
  }
}

/** An in-memory registry that keeps every state it was ever asked to save. */
class MemoryRegistry {
  readonly history: ManagedWorktreeRegistryState[] = [];

  constructor(private current: ManagedWorktreeRegistryState = { worktrees: [], intents: [] }) {}

  async read(): Promise<ManagedWorktreeRegistryState> {
    return this.current;
  }

  async write(mutate: (state: ManagedWorktreeRegistryState) => ManagedWorktreeRegistryState): Promise<void> {
    this.current = mutate(this.current);
    this.history.push(this.current);
  }

  get state(): ManagedWorktreeRegistryState {
    return this.current;
  }
}

function build(
  options: {
    readonly entries?: readonly ManagedWorktree[];
    readonly intents?: readonly ManagedWorktreeIntent[];
    readonly operations?: RecordingOperations;
    readonly sessions?: readonly WorktreeSessionFact[];
    readonly sessionEvidence?: () => Promise<readonly WorktreeSessionFact[] | undefined>;
    readonly terminalRoots?: readonly string[];
    readonly projects?: readonly ProjectInfo[];
    readonly managedRoot?: string | undefined;
    readonly ids?: readonly string[];
  } = {},
) {
  const registry = new MemoryRegistry({ worktrees: options.entries ?? [], intents: options.intents ?? [] });
  const operations = options.operations ?? new RecordingOperations();
  const minted = [...(options.ids ?? ['id-one-0000', 'id-two-0000'])];
  const subject = new ManagedWorktreeService(
    registry,
    operations,
    { sessions: options.sessionEvidence ?? (async () => options.sessions ?? []) },
    { roots: async () => options.terminalRoots ?? [] },
    { projects: async () => options.projects ?? [] },
    { nowIso: () => '2026-08-04T09:00:00.000Z' },
    { next: () => minted.shift() ?? 'exhausted' },
    'managedRoot' in options ? options.managedRoot : MANAGED_ROOT,
  );
  return { subject, registry, operations };
}

const thrown = async (operation: Promise<unknown>): Promise<unknown> =>
  await operation.then(() => undefined).catch((error: unknown) => error);

/** A deterministic boundary: the test observes entry, then decides when the operation may continue. */
function deferredBoundary(): {
  readonly entered: Promise<void>;
  readonly wait: () => Promise<void>;
  readonly release: () => void;
} {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    wait: async () => {
      entered.resolve();
      await released.promise;
    },
    release: () => released.resolve(),
  };
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  await Promise.resolve();
  should(settled).be.false();
}

describe('whether a session may still be holding a checkout', () => {
  it('should treat a session as active until it is PROVEN finished', () => {
    // Act + Assert — a terminal status with no instant is incomplete evidence, so it counts as alive
    should(isWorktreeSessionActive(session({ status: 'running' }))).be.true();
    should(isWorktreeSessionActive(session({ status: 'waiting' }))).be.true();
    should(isWorktreeSessionActive(session({ status: 'completed' }))).be.true();
    should(
      isWorktreeSessionActive(session({ status: 'completed', finishedAt: '2026-08-04T01:00:00.000Z' })),
    ).be.false();
    should(
      isWorktreeSessionActive(session({ status: 'kill_failed', finishedAt: '2026-08-04T01:00:00.000Z' })),
    ).be.false();
  });
});

describe('assembling the removal question from host evidence', () => {
  it('should count only the terminals rooted inside the checkout', () => {
    // Act
    const actual = managedWorktreeRemovalContext({
      managed: record(),
      managedRoot: MANAGED_ROOT,
      sessions: [],
      terminalRoots: ['/managed/repo/feat-one/packages', '/managed/repo/feat-one', '/work/ferretry', '/elsewhere'],
    });

    // Assert
    should(actual.liveTerminals).equal(2);
  });

  it('should separate the owner from every other live session', () => {
    // Act
    const actual = managedWorktreeRemovalContext({
      managed: record(),
      managedRoot: MANAGED_ROOT,
      sessions: [
        session(),
        session({ id: 'sess-2', cwd: '/managed/repo/feat-one' }),
        session({ id: 'sess-3', status: 'stopped', finishedAt: '2026-08-04T01:00:00.000Z' }),
      ],
      terminalRoots: [],
      currentWorkingDirectory: '/work/ferretry',
      confirmations: ['delete_unmerged_branch'],
    });

    // Assert — a finished session is not evidence that anybody is still there
    should(actual.ownerActive).be.true();
    should(actual.otherSessions?.map(entry => entry.id)).eql(['sess-2']);
    should(actual.currentWorkingDirectory).equal('/work/ferretry');
    should(actual.confirmations).eql(['delete_unmerged_branch']);
  });

  it('should report an unowned checkout as having no active owner', () => {
    // Act
    const actual = managedWorktreeRemovalContext({
      managed: record({ ownerSessionId: undefined }),
      managedRoot: MANAGED_ROOT,
      sessions: [session()],
      terminalRoots: [],
    });

    // Assert
    should(actual.ownerActive).be.false();
    should(actual.otherSessions?.map(entry => entry.id)).eql(['sess-1']);
    should(actual.currentWorkingDirectory).be.undefined();
    should(actual.confirmations).be.undefined();
  });
});

describe('ordering the list', () => {
  it('should put live checkouts before tombstones, newest first within each', () => {
    // Arrange
    const view = (path: string, createdAt: string, removedAt?: string): ManagedWorktreeView => ({
      path,
      branch: 'feat/one',
      repositoryRoot: '/work/ferretry',
      commonDirectory: '/work/ferretry/.git',
      relativeCwd: '',
      createdAt,
      initialHead: 'a'.repeat(40),
      branchPreexisted: false,
      ownerActive: false,
      sharedWith: [],
      ...(removedAt === undefined ? {} : { removedAt }),
    });

    // Act
    const actual = orderManagedWorktreeViews([
      view('/old-tomb', '2026-08-01T00:00:00.000Z', '2026-08-05T00:00:00.000Z'),
      view('/older-live', '2026-08-02T00:00:00.000Z'),
      view('/newer-live', '2026-08-03T00:00:00.000Z'),
    ]);

    // Assert
    should(actual.map(entry => entry.path)).eql(['/newer-live', '/older-live', '/old-tomb']);
  });
});

describe('the managed-worktree surface', () => {
  it('should refresh every live row against Git rather than replaying the registry', async () => {
    // Arrange
    const { subject, operations } = build({
      entries: [record(), record({ path: '/managed/repo/feat-two', branch: 'feat/two' })],
    });

    // Act
    const actual = await subject.list();

    // Assert — one inspection per live row, on every read
    should(operations.examined).have.length(2);
    should(actual.managedRoot).equal(MANAGED_ROOT);
    should(actual.worktrees[0]?.live).match({ head: 'b'.repeat(40) });
    should(actual.worktrees[0]?.removal).match({ removable: true });
  });

  it('should project the durable facts and the occupancy beside the live evidence', async () => {
    // Arrange
    const { subject } = build({
      entries: [record()],
      sessions: [session(), session({ id: 'sess-2', cwd: '/managed/repo/feat-one/packages/cli' })],
      projects: [PROJECT],
    });

    // Act
    const actual = await subject.list();

    // Assert
    should(actual.worktrees[0]).match({
      path: '/managed/repo/feat-one',
      commonDirectory: '/work/ferretry/.git',
      relativeCwd: 'packages/cli',
      initialHead: 'a'.repeat(40),
      branchPreexisted: false,
      ownerSessionId: 'sess-1',
      ownerActive: true,
      sharedWith: ['sess-2'],
      projectId: PROJECT.id,
    });
  });

  it('should leave a checkout whose repository no Project records unjoined', async () => {
    // Arrange — matched on the common directory, so a Project elsewhere on disk is not a match
    const { subject } = build({
      entries: [record()],
      projects: [{ ...PROJECT, git: { commonDirectory: '/work/other/.git' } }],
    });

    // Act
    const actual = await subject.list();

    // Assert
    should(actual.worktrees[0]?.projectId).be.undefined();
  });

  it('should not inspect a tombstone: there is nothing left on disk to read', async () => {
    // Arrange
    const { subject, operations } = build({
      entries: [record({ removedAt: '2026-08-04T02:00:00.000Z', ownerSessionId: undefined })],
    });

    // Act
    const actual = await subject.list();

    // Assert
    should(operations.examined).be.empty();
    should(actual.worktrees[0]).match({ removedAt: '2026-08-04T02:00:00.000Z', ownerActive: false });
    should(actual.worktrees[0]?.live).be.undefined();
    should(actual.worktrees[0]?.ownerSessionId).be.undefined();
  });

  it('should say plainly that a daemon with no managed root hosts nothing', async () => {
    // Arrange
    const { subject, operations } = build({ entries: [record()], managedRoot: undefined });

    // Act
    const actual = await subject.list();

    // Assert
    should(actual.managedRoot).be.undefined();
    should(actual.worktrees[0]?.removal).be.undefined();
    should(operations.examined).be.empty();
  });

  it('should answer a check with the verdict the refresh produced', async () => {
    // Arrange
    const { subject, operations } = build({ entries: [record()] });

    // Act
    const actual = await subject.checkRemoval('/managed/repo/feat-one', '/work/ferretry');

    // Assert
    should(actual.removable).be.true();
    should(operations.examined[0]?.currentWorkingDirectory).equal('/work/ferretry');
  });

  it('should omit a caller directory nobody sent rather than inventing one', async () => {
    // Arrange
    const { subject, operations } = build({ entries: [record()] });

    // Act
    await subject.checkRemoval('/managed/repo/feat-one');

    // Assert
    should(operations.examined[0]?.currentWorkingDirectory).be.undefined();
  });

  it('should refuse a path it holds no record of', async () => {
    // Arrange
    const { subject } = build({ entries: [record()] });

    // Act
    const error = await thrown(subject.checkRemoval('/managed/nowhere'));

    // Assert
    should(error).be.instanceof(WorktreeError);
    should((error as WorktreeError).code).equal('unknown_worktree');
  });

  it('should refuse a checkout it already removed, and say when', async () => {
    // Arrange
    const { subject } = build({ entries: [record({ removedAt: '2026-08-04T02:00:00.000Z' })] });

    // Act
    const error = await thrown(subject.checkRemoval('/managed/repo/feat-one'));

    // Assert
    should((error as WorktreeError).code).equal('unknown_worktree');
    should((error as WorktreeError).message).containEql('already removed at 2026-08-04T02:00:00.000Z');
  });

  it('should carry consent to the removal and strike the record only after it succeeded', async () => {
    // Arrange
    const { subject, registry, operations } = build({ entries: [record()] });

    // Act
    const actual = await subject.remove({
      path: '/managed/repo/feat-one',
      overrides: ['discard_worktree_changes'],
      deleteBranch: true,
      confirmations: ['delete_unmerged_branch'],
      currentWorkingDirectory: '/somewhere/else',
    });

    // Assert
    should(operations.removals[0]).match({
      overrides: ['discard_worktree_changes'],
      deleteBranch: true,
      confirmations: ['delete_unmerged_branch'],
      currentWorkingDirectory: '/somewhere/else',
    });
    should(registry.state.worktrees[0]).match({
      removalStartedAt: '2026-08-04T09:00:00.000Z',
      removedAt: '2026-08-04T02:00:00.000Z',
    });
    should(actual).match({ branchRetained: true, branchBlockers: [] });
  });

  it('should tombstone the checkout when a later branch-deletion step reports failure', async () => {
    // Arrange
    const operations = new RecordingOperations({
      removed: {
        path: '/managed/repo/feat-one',
        branch: 'feat/one',
        branchRetained: true,
        branchBlockers: [{ code: 'git_error', message: 'branch deletion failed: Git refused' }],
        removedAt: '2026-08-04T02:00:00.000Z',
      },
    });
    const { subject, registry } = build({ entries: [record()], operations });

    // Act
    const actual = await subject.remove({
      path: '/managed/repo/feat-one',
      overrides: [],
      deleteBranch: true,
      confirmations: [],
    });

    // Assert — checkout success is durable even though the independently requested branch step failed
    should(actual.branchBlockers.map(entry => entry.code)).eql(['git_error']);
    should(actual.branchRetained).be.true();
    should(registry.state.worktrees[0]?.removedAt).equal('2026-08-04T02:00:00.000Z');
  });

  it('should refresh session occupancy inside the removal operation before mutation', async () => {
    // Arrange — the owner becomes active after the service's first evidence snapshot
    let reads = 0;
    const operations = new (class extends RecordingOperations {
      override async remove(input: RemoveManagedWorktreeInput): Promise<RemovedManagedWorktree> {
        const fresh = await input.refreshEvidence?.();
        should(fresh?.ownerActive).be.true();
        throw new WorktreeRemovalRefusal('refusing to remove: the owner became active');
      }
    })();
    const { subject, registry } = build({
      entries: [record()],
      operations,
      sessionEvidence: async () => {
        reads += 1;
        return reads === 1 ? [] : [session()];
      },
    });

    // Act
    const error = await thrown(
      subject.remove({ path: record().path, overrides: [], deleteBranch: false, confirmations: [] }),
    );

    // Assert — the typed final refusal safely clears the pre-mutation recovery stamp
    should((error as Error).message).containEql('owner became active');
    should(reads).equal(2);
    should(registry.state.worktrees[0]?.removalStartedAt).be.undefined();
  });

  it('should refuse to remove a record it does not hold', async () => {
    // Arrange
    const { subject, registry } = build({ entries: [] });

    // Act
    const error = await thrown(
      subject.remove({ path: '/managed/nowhere', overrides: [], deleteBranch: false, confirmations: [] }),
    );

    // Assert
    should((error as WorktreeError).code).equal('unknown_worktree');
    should(registry.history).be.empty();
  });

  it('should fork a checkout, file it, and answer with the directory to start work in', async () => {
    // Arrange
    const { subject, registry, operations } = build({ projects: [PROJECT] });

    // Act
    const actual = await subject.create({
      sourcePath: '/work/ferretry/packages/cli',
      branch: 'feat/one',
      base: { kind: 'default-branch' },
      sessionId: 'sess-1',
    });

    // Assert
    should(operations.creations[0]).match({
      sourceCwd: '/work/ferretry/packages/cli',
      branch: 'feat/one',
      sessionId: 'sess-1',
      ownerSessionId: 'sess-1',
      ownershipToken: 'id-one-0000',
      managedRoot: MANAGED_ROOT,
      base: { kind: 'default-branch' },
    });
    should(registry.state.worktrees).have.length(1);
    should(actual.cwd).equal('/managed/repo/feat-one/packages/cli');
    should(actual.worktree.projectId).equal(PROJECT.id);
  });

  it('should key an unowned checkout by a minted id, and record no owner for it', async () => {
    // Arrange
    const { subject, operations } = build({ ids: ['minted-key-1', 'minted-token-1'] });

    // Act
    const actual = await subject.create({ sourcePath: '/work/ferretry', branch: 'feat/one', base: { kind: 'auto' } });

    // Assert
    should(operations.creations[0]?.sessionId).equal('unowned-minted-key-1');
    should(operations.creations[0]?.ownerSessionId).be.undefined();
    should(operations.creations[0]?.ownershipToken).equal('minted-token-1');
    should(actual.worktree.ownerSessionId).be.undefined();
  });

  it('should refuse to fork at all on a daemon that hosts no managed checkouts', async () => {
    // Arrange
    const { subject, registry } = build({ managedRoot: undefined });

    // Act
    const error = await thrown(
      subject.create({ sourcePath: '/work/ferretry', branch: 'feat/one', base: { kind: 'auto' } }),
    );

    // Assert
    should((error as WorktreeError).code).equal('no_managed_root');
    should(registry.history).be.empty();
  });
});

describe('serializing complete worktree lifecycles', () => {
  it('should make list wait while a declared creation is still between intent and Git', async () => {
    // Arrange
    const boundary = deferredBoundary();
    const operations = new RecordingOperations({ afterPlanned: async () => await boundary.wait() });
    const { subject, registry } = build({ operations });

    // Act
    const creating = subject.create({ sourcePath: '/work/ferretry', branch: 'feat/one', base: { kind: 'auto' } });
    await boundary.entered;
    const listing = subject.list();

    // Assert — reconciliation cannot observe the in-flight intent as absent and erase it
    should(registry.state.intents).have.length(1);
    await expectPending(listing);
    should(operations.adopted).be.empty();
    boundary.release();
    await creating;
    const listed = await listing;
    should(registry.state.intents).be.empty();
    should(listed.worktrees[0]?.unresolved).be.undefined();
  });

  it('should make list wait while a stamped removal is still in Git', async () => {
    // Arrange
    const boundary = deferredBoundary();
    const operations = new RecordingOperations({ beforeRemove: async () => await boundary.wait() });
    const { subject, registry } = build({ entries: [record()], operations });

    // Act
    const removing = subject.remove({ path: record().path, overrides: [], deleteBranch: false, confirmations: [] });
    await boundary.entered;
    const listing = subject.list();

    // Assert — reconciliation cannot see the still-present checkout and clear the in-flight stamp
    should(registry.state.worktrees[0]?.removalStartedAt).be.a.String();
    await expectPending(listing);
    should(operations.probed).be.empty();
    boundary.release();
    await removing;
    const listed = await listing;
    should(listed.worktrees[0]?.removedAt).be.a.String();
  });

  it('should let exactly one same-branch create win without the loser disturbing its record', async () => {
    // Arrange
    const operations = new (class extends RecordingOperations {
      private calls = 0;

      override async create(input: CreateManagedWorktreeInput): Promise<CreatedManagedWorktree> {
        this.calls += 1;
        if (this.calls > 1) throw new WorktreeError('branch_in_use', 'branch "feat/one" is already checked out');
        return await super.create(input);
      }
    })();
    const { subject, registry } = build({ operations });
    const request = { sourcePath: '/work/ferretry', branch: 'feat/one', base: { kind: 'auto' } } as const;

    // Act
    const [winner, loser] = await Promise.allSettled([subject.create(request), subject.create(request)]);

    // Assert
    should(winner.status).equal('fulfilled');
    should(loser.status).equal('rejected');
    should(loser.status === 'rejected' ? (loser.reason as WorktreeError).code : undefined).equal('branch_in_use');
    should(registry.state.intents).be.empty();
    should(registry.state.worktrees).have.length(1);
    should(registry.state.worktrees[0]?.branch).equal('feat/one');
    should((await subject.list()).worktrees).have.length(1);
  });

  it('should settle concurrent same-path removes in reverse arrival order without reviving the winner', async () => {
    // Arrange
    const boundary = deferredBoundary();
    const operations = new RecordingOperations({ beforeRemove: async () => await boundary.wait() });
    const { subject, registry } = build({ entries: [record()], operations });
    const request: WorktreeRemovalRequest = {
      path: record().path,
      overrides: [],
      deleteBranch: false,
      confirmations: [],
    };

    // Act
    const first = subject.remove(request);
    await boundary.entered;
    const second = subject.remove(request);
    await expectPending(second);
    boundary.release();
    await first;
    const secondError = await thrown(second);

    // Assert
    should((secondError as WorktreeError).code).equal('unknown_worktree');
    should(operations.removals).have.length(1);
    should(registry.state.worktrees[0]?.removedAt).be.a.String();
  });
});

describe('surviving a crash between the registry and Git', () => {
  const intent = (overrides: Partial<ManagedWorktreeIntent> = {}): ManagedWorktreeIntent => ({
    version: 1,
    path: '/managed/repo/feat-one',
    branch: 'feat/one',
    repositoryRoot: '/work/ferretry',
    commonDir: '/work/ferretry/.git',
    ownershipToken: 'ownership-token-0001',
    declaredAt: '2026-08-04T00:00:00.000Z',
    initialHead: 'a'.repeat(40),
    branchPreexisted: false,
    sourceCwd: '/work/ferretry/packages/cli',
    relativeCwd: 'packages/cli',
    ownerSessionId: 'sess-1',
    ...overrides,
  });

  it('should declare the creation BEFORE Git makes it, so a crash leaves no unregistered checkout', async () => {
    // Arrange
    const { subject, registry } = build();

    // Act
    await subject.create({ sourcePath: '/work/ferretry/packages/cli', branch: 'feat/one', base: { kind: 'auto' } });

    // Assert — the first save happens while the plan is known and before `worktree add` is run
    should(registry.history[0]?.intents).have.length(1);
    should(registry.history[0]?.intents[0]).match({
      path: '/managed/repo/feat-one',
      declaredAt: '2026-08-04T09:00:00.000Z',
      initialHead: 'a'.repeat(40),
    });
    should(registry.history[0]?.worktrees).be.empty();
    // …and the finished record retires that intent rather than sitting beside it
    should(registry.state.intents).be.empty();
    should(registry.state.worktrees).have.length(1);
  });

  it('should adopt an interrupted creation whose checkout is there and proves it is ours', async () => {
    // Arrange — the daemon died after `worktree add` and before the record was filed
    const operations = new RecordingOperations({ adoption: { kind: 'adopted', managed: record() } });
    const { subject, registry } = build({ intents: [intent()], operations });

    // Act
    const actual = await subject.list();

    // Assert
    should(operations.adopted).have.length(1);
    should(registry.state.intents).be.empty();
    should(registry.state.worktrees).have.length(1);
    should(actual.worktrees[0]?.unresolved).be.undefined();
    should(actual.worktrees[0]?.live).not.be.undefined();
  });

  it('should drop an interrupted creation Git never got as far as making', async () => {
    // Arrange
    const operations = new RecordingOperations({ adoption: { kind: 'absent' } });
    const { subject, registry } = build({ intents: [intent()], operations });

    // Act
    const actual = await subject.list();

    // Assert
    should(registry.state.intents).be.empty();
    should(actual.worktrees).be.empty();
  });

  it('should KEEP and report a leftover it cannot prove is its own, rather than hiding it', async () => {
    // Arrange — something is at that path and does not verify; dropping the row is what makes a
    // stranded directory invisible.
    const operations = new RecordingOperations({
      adoption: { kind: 'unverified', reason: 'carries no ownership marker this daemon minted' },
    });
    const { subject, registry } = build({ intents: [intent()], operations, projects: [PROJECT] });

    // Act
    const actual = await subject.list();

    // Assert
    should(registry.state.intents).have.length(1);
    should(actual.worktrees[0]).match({
      path: '/managed/repo/feat-one',
      branch: 'feat/one',
      ownerActive: false,
      projectId: PROJECT.id,
    });
    should(actual.worktrees[0]?.unresolved).containEql('never finished');
    should(actual.worktrees[0]?.live).be.undefined();
  });

  it('should refuse to act on an unresolved leftover by name rather than by silence', async () => {
    // Arrange
    const operations = new RecordingOperations({ adoption: { kind: 'unverified', reason: 'not ours' } });
    const { subject } = build({ intents: [intent()], operations });

    // Act
    const error = await thrown(subject.checkRemoval('/managed/repo/feat-one'));

    // Assert
    should((error as WorktreeError).code).equal('unknown_worktree');
    should((error as WorktreeError).message).containEql('unfinished creation');
  });

  it('should stamp the removal BEFORE Git destroys anything, so a crash leaves a healable row', async () => {
    // Arrange
    const { subject, registry } = build({ entries: [record()] });

    // Act
    await subject.remove({ path: '/managed/repo/feat-one', overrides: [], deleteBranch: false, confirmations: [] });

    // Assert — the stamp is saved first, and the tombstone lands on top of it
    should(registry.history[0]?.worktrees[0]?.removalStartedAt).equal('2026-08-04T09:00:00.000Z');
    should(registry.history[0]?.worktrees[0]?.removedAt).be.undefined();
    should(registry.state.worktrees[0]?.removedAt).equal('2026-08-04T02:00:00.000Z');
  });

  it('should clear the stamp only for a typed refusal proved before mutation', async () => {
    // Arrange
    const operations = new RecordingOperations({
      removalFails: new WorktreeRemovalRefusal('refusing to remove: it is dirty'),
    });
    const { subject, registry } = build({ entries: [record()], operations });

    // Act
    const error = await thrown(
      subject.remove({ path: '/managed/repo/feat-one', overrides: [], deleteBranch: false, confirmations: [] }),
    );

    // Assert
    should((error as Error).message).containEql('refusing to remove');
    should(registry.state.worktrees[0]?.removalStartedAt).be.undefined();
    should(registry.state.worktrees[0]?.removedAt).be.undefined();
  });

  it('should tombstone when the checkout disappeared before a later removal failure', async () => {
    // Arrange — models `git worktree remove` succeeding before a later operation throws
    const operations = new RecordingOperations({
      removalFails: new Error('a later step failed'),
      presence: { kind: 'absent' },
    });
    const { subject, registry } = build({ entries: [record()], operations });

    // Act
    const error = await thrown(
      subject.remove({ path: record().path, overrides: [], deleteBranch: false, confirmations: [] }),
    );

    // Assert — the thrown error is preserved, but the durable row tells the truth about the checkout
    should((error as Error).message).equal('a later step failed');
    should(operations.probed).eql([record().path]);
    should(registry.state.worktrees[0]?.removedAt).equal('2026-08-04T09:00:00.000Z');
  });

  it('should retain the recovery stamp when an ambiguous failure cannot be reconciled', async () => {
    // Arrange
    const operations = new RecordingOperations({
      removalFails: new Error('Git timed out'),
      existsFails: new Error('the filesystem is unavailable'),
    });
    const { subject, registry } = build({ entries: [record()], operations });

    // Act
    await thrown(subject.remove({ path: record().path, overrides: [], deleteBranch: false, confirmations: [] }));

    // Assert — no observation proved either outcome, so the next read still has evidence to settle
    should(registry.state.worktrees[0]?.removalStartedAt).equal('2026-08-04T09:00:00.000Z');
    should(registry.state.worktrees[0]?.removedAt).be.undefined();
  });

  it('should confirm an interrupted removal whose checkout is gone, so a retry stops failing forever', async () => {
    // Arrange — the daemon died after `worktree remove` and before the tombstone was written
    const operations = new RecordingOperations({ presence: { kind: 'absent' } });
    const { subject, registry } = build({
      entries: [record({ removalStartedAt: '2026-08-04T02:00:00.000Z' })],
      operations,
    });

    // Act
    const actual = await subject.list();

    // Assert — without this the row stayed live and every retry refused on `missing_worktree`
    should(operations.probed).eql(['/managed/repo/feat-one']);
    should(registry.state.worktrees[0]?.removedAt).equal('2026-08-04T09:00:00.000Z');
    should(actual.worktrees[0]?.removedAt).equal('2026-08-04T09:00:00.000Z');
    should(actual.worktrees[0]?.live).be.undefined();
  });

  it('should put an interrupted removal back to live when the checkout is still there', async () => {
    // Arrange
    const operations = new RecordingOperations({ presence: { kind: 'owned' } });
    const { subject, registry } = build({
      entries: [record({ removalStartedAt: '2026-08-04T02:00:00.000Z' })],
      operations,
    });

    // Act
    const actual = await subject.list();

    // Assert
    should(registry.state.worktrees[0]?.removalStartedAt).be.undefined();
    should(registry.state.worktrees[0]?.removedAt).be.undefined();
    should(actual.worktrees[0]?.removal).match({ removable: true });
  });

  it('should keep an interrupted stamp when another incarnation now occupies the path', async () => {
    // Arrange
    const operations = new RecordingOperations({
      presence: { kind: 'unverified', reason: 'the ownership token belongs to a replacement' },
    });
    const { subject, registry } = build({
      entries: [record({ removalStartedAt: '2026-08-04T02:00:00.000Z' })],
      operations,
    });

    // Act
    await subject.list();

    // Assert — mere pathname reuse proves nothing about the interrupted incarnation
    should(registry.state.worktrees[0]?.removalStartedAt).equal('2026-08-04T02:00:00.000Z');
    should(registry.state.worktrees[0]?.removedAt).be.undefined();
  });

  it('should run no reconciliation at all when the registry has nothing outstanding', async () => {
    // Arrange — the ordinary read, which must not pay for a recovery path it does not need
    const operations = new RecordingOperations();
    const { subject, registry } = build({ entries: [record()], operations });

    // Act
    await subject.list();

    // Assert
    should(operations.adopted).be.empty();
    should(operations.probed).be.empty();
    should(registry.history).be.empty();
  });
});

describe('host evidence this daemon could not establish', () => {
  it('should refuse a removal it cannot rule out a live shell for, rather than counting zero', () => {
    // Act
    const actual = managedWorktreeRemovalContext({
      managed: record(),
      managedRoot: MANAGED_ROOT,
      sessions: [],
      terminalRoots: undefined,
    });

    // Assert — a tmux server that will not answer is not a checkout with no shells in it
    should(actual.liveTerminals).equal(0);
    should(actual.undeterminedEvidence).have.length(1);
    should(actual.undeterminedEvidence?.[0]).containEql('terminals could not be listed');
  });

  it('should refuse a removal it cannot rule out an agent for', () => {
    // Act
    const actual = managedWorktreeRemovalContext({
      managed: record(),
      managedRoot: MANAGED_ROOT,
      sessions: undefined,
      terminalRoots: [],
    });

    // Assert
    should(actual.ownerActive).be.false();
    should(actual.otherSessions).be.empty();
    should(actual.undeterminedEvidence?.[0]).containEql('session directory could not be read');
  });

  it('should name both gaps when neither could be read', () => {
    // Act
    const actual = managedWorktreeRemovalContext({
      managed: record(),
      managedRoot: MANAGED_ROOT,
      sessions: undefined,
      terminalRoots: undefined,
    });

    // Assert
    should(actual.undeterminedEvidence).have.length(2);
  });

  it('should still answer the list when the host evidence is unreadable', async () => {
    // Arrange — the defect the end-to-end journey found: an unreadable tmux took the surface down
    const registry = new MemoryRegistry({ worktrees: [record()], intents: [] });
    const operations = new RecordingOperations();
    const subject = new ManagedWorktreeService(
      registry,
      operations,
      { sessions: async () => undefined },
      { roots: async () => undefined },
      { projects: async () => [] },
      { nowIso: () => '2026-08-04T09:00:00.000Z' },
      { next: () => 'id-0000-0000' },
      MANAGED_ROOT,
    );

    // Act
    const actual = await subject.list();

    // Assert — a read still succeeds, and it carries the refusal a write would hit
    should(actual.worktrees).have.length(1);
    should(operations.examined[0]?.undeterminedEvidence).have.length(2);
    should(actual.worktrees[0]?.ownerActive).be.false();
  });
});
