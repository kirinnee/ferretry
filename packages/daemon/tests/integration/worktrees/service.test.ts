import { afterAll, describe, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { mkdir, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { BunGitRunner } from '../../../src/adapters/git/index.ts';
import { PosixSessionRootPinner, ProcfsSessionRootPinner } from '../../../src/adapters/session/filesystem/index.ts';
import {
  GitWorktreeGateway,
  ManagedWorktreeAdapter,
  NodeWorktreeFileSystem,
  SystemWorktreeClock,
  WorktreeOperationQueue,
} from '../../../src/adapters/worktrees/index.ts';
import { WorktreeError } from '../../../src/lib/worktrees/index.ts';
import type {
  GitExecution,
  GitInvocation,
  GitRunner,
  WorktreeDirectoryPinner,
} from '../../../src/lib/worktrees/ports.ts';
import type {
  CheckManagedWorktreeRemovalInput,
  CreateManagedWorktreeInput,
  CreatedManagedWorktree,
  ManagedWorktree,
  ManagedWorktreeIntent,
  ManagedWorktreePlan,
  WorktreeRemovalDecision,
  WorktreeRemovalOverride,
} from '../../../src/lib/worktrees/types.ts';
import { cleanupTempDirectories, setupGit, tempDirectory, tempRemote, tempRepository } from '../support/repository.ts';

const files = new NodeWorktreeFileSystem();
const clock = new SystemWorktreeClock();
const TOKEN = 'ownership-token-0001';

/** Replays crafted Git results for the defensive paths, and delegates everything else to Git. */
class ScriptedGitRunner implements GitRunner {
  constructor(
    private readonly reply: (invocation: GitInvocation) => GitExecution | Promise<GitExecution> | undefined,
  ) {}

  async run(invocation: GitInvocation): Promise<GitExecution> {
    return (await this.reply(invocation)) ?? (await new BunGitRunner().run(invocation));
  }
}

const directoryPinner = (): WorktreeDirectoryPinner =>
  process.platform === 'linux' ? new ProcfsSessionRootPinner() : new PosixSessionRootPinner();

const adapter = (
  runner: GitRunner = new BunGitRunner(),
  pinner: WorktreeDirectoryPinner = directoryPinner(),
): ManagedWorktreeAdapter =>
  new ManagedWorktreeAdapter(
    new GitWorktreeGateway(runner, files, clock),
    files,
    clock,
    new WorktreeOperationQueue(),
    pinner,
  );

/** Swaps one validated name immediately before the final pin opens it. */
class SwapBeforePin implements WorktreeDirectoryPinner {
  readonly moved: string;
  private swapped = false;

  constructor(
    private readonly target: string,
    private readonly replacement: string,
    private readonly delegate: WorktreeDirectoryPinner = directoryPinner(),
  ) {
    this.moved = `${target}.pinned-original`;
  }

  async pin(cwd: string) {
    if (!this.swapped && path.resolve(cwd) === path.resolve(this.target)) {
      this.swapped = true;
      await rename(this.target, this.moved);
      await symlink(this.replacement, this.target, 'dir');
    }
    return await this.delegate.pin(cwd);
  }
}

const error = async (operation: Promise<unknown>): Promise<unknown> =>
  await operation.then(() => undefined).catch((thrown: unknown) => thrown);

const code = (thrown: unknown): string | undefined => (thrown as WorktreeError | undefined)?.code;

/** The removal verdict alone: one refresh reads live state and the decision together now. */
const checkRemoval = async (
  subject: ManagedWorktreeAdapter,
  input: CheckManagedWorktreeRemovalInput,
): Promise<WorktreeRemovalDecision> => (await subject.examine(input)).decision;

interface Scenario {
  readonly sourceCwd: string;
  readonly managedRoot: string;
  readonly head: string;
}

async function scenario(label: string): Promise<Scenario> {
  const repository = await tempRepository(label);
  const managedRoot = path.join(await tempDirectory(`${label}-managed`), 'worktrees');
  return { sourceCwd: repository.root, managedRoot, head: repository.head };
}

const request = (base: Scenario, overrides: Partial<CreateManagedWorktreeInput> = {}): CreateManagedWorktreeInput => ({
  sourceCwd: base.sourceCwd,
  branch: 'feature/managed',
  sessionId: 'session-1',
  ownershipToken: TOKEN,
  managedRoot: base.managedRoot,
  ...overrides,
});

describe('ManagedWorktreeAdapter creation', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  it('should create a private checkout on a new branch and record its identity', async () => {
    // Arrange
    const base = await scenario('svc-create');
    const planned: ManagedWorktreePlan[] = [];

    // Act
    const actual = await adapter().create(request(base, { onPlanned: async plan => void planned.push(plan) }));

    // Assert
    should(actual.managed.version).equal(1);
    should(actual.managed.branch).equal('feature/managed');
    should(actual.managed.initialHead).equal(base.head);
    should(actual.managed.branchPreexisted).be.false();
    should(actual.managed.ownershipToken).equal(TOKEN);
    should(actual.cwd).equal(actual.managed.path);
    should(actual.checkout.kind).equal('linked_worktree');
    should(actual.managed.path.startsWith(base.managedRoot)).be.true();
    should(planned).have.length(1);
    should(planned[0]?.branch).equal('feature/managed');
    should(await files.readText(path.join(actual.managed.gitDir, 'worktree-owner'))).equal(TOKEN);
  });

  it('should keep the managed root and repository directory private to the daemon', async () => {
    // Arrange
    const base = await scenario('svc-create-mode');

    // Act
    const actual = await adapter().create(request(base));

    // Assert
    should(await files.type(base.managedRoot)).equal('directory');
    should(path.dirname(actual.managed.path)).not.equal(base.managedRoot);
    should(path.dirname(path.dirname(actual.managed.path))).equal(base.managedRoot);
  });

  it('should give two sessions on one branch name distinct destinations', async () => {
    // Arrange — colliding on one directory is how two sessions would corrupt each other.
    const base = await scenario('svc-create-distinct');
    const first = await adapter().create(request(base));

    // Act
    const second = await adapter().create(request(base, { branch: 'feature/other', sessionId: 'session-2' }));

    // Assert
    should(second.managed.path).not.equal(first.managed.path);
    should(path.dirname(second.managed.path)).equal(path.dirname(first.managed.path));
  });

  it('should check out a branch that already exists rather than recreating it', async () => {
    // Arrange
    const base = await scenario('svc-create-existing');
    await setupGit(base.sourceCwd, 'branch', '--', 'feature/managed');

    // Act
    const actual = await adapter().create(request(base));

    // Assert
    should(actual.managed.branchPreexisted).be.true();
    should(actual.managed.initialHead).equal(base.head);
  });

  it('should start a new branch from an explicit start point', async () => {
    // Arrange
    const base = await scenario('svc-create-start');
    await setupGit(base.sourceCwd, 'commit', '--quiet', '--allow-empty', '-m', 'feat: later');

    // Act
    const actual = await adapter().create(request(base, { base: { kind: 'commit', reference: `  ${base.head}  ` } }));

    // Assert
    should(actual.managed.initialHead).equal(base.head);
  });

  it('should track the single remote branch of the same name when there is one', async () => {
    // Arrange
    const base = await scenario('svc-create-tracking');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'push', '--quiet', 'origin', 'main:feature/managed');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');

    // Act
    const actual = await adapter().create(request(base));

    // Assert
    should(actual.managed.branchPreexisted).be.false();
    should(actual.managed.initialHead).equal(base.head);
  });

  it('should refuse to guess when several remotes carry the same branch name', async () => {
    // Arrange
    const base = await scenario('svc-create-ambiguous');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await tempRemote(base.sourceCwd, 'upstream', 'main');
    await setupGit(base.sourceCwd, 'push', '--quiet', 'origin', 'main:feature/managed');
    await setupGit(base.sourceCwd, 'push', '--quiet', 'upstream', 'main:feature/managed');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', '--all');

    // Act
    const actual = await error(adapter().create(request(base)));

    // Assert
    should(code(actual)).equal('ambiguous_remote_branch');
  });

  it('should refuse a branch that is already checked out somewhere else', async () => {
    // Arrange
    const base = await scenario('svc-create-in-use');
    const other = path.join(await tempDirectory('svc-create-in-use-other'), 'wt');
    await setupGit(base.sourceCwd, 'worktree', 'add', '-b', 'feature/managed', '--', other);

    // Act
    const actual = await error(adapter().create(request(base)));

    // Assert
    should(code(actual)).equal('branch_in_use');
    should((actual as WorktreeError).message).containEql(other);
  });

  it.each([
    { label: 'a path-traversing session id', overrides: { sessionId: '../escape' }, expected: 'invalid_session_id' },
    { label: 'an empty session id', overrides: { sessionId: '' }, expected: 'invalid_session_id' },
    { label: 'a short ownership token', overrides: { ownershipToken: 'short' }, expected: 'invalid_ownership_token' },
    {
      label: 'an ownership token with separators',
      overrides: { ownershipToken: 'token with spaces' },
      expected: 'invalid_ownership_token',
    },
  ])('should refuse $label before touching Git', async ({ overrides, expected }) => {
    // Arrange
    const base = await scenario('svc-create-unsafe');

    // Act
    const actual = await error(adapter().create(request(base, overrides)));

    // Assert
    should(code(actual)).equal(expected);
  });

  it('should refuse a source that is not a Git checkout', async () => {
    // Arrange
    const base = await scenario('svc-create-not-git');
    const plain = await tempDirectory('svc-create-plain');

    // Act
    const actual = await error(adapter().create(request(base, { sourceCwd: plain })));

    // Assert
    should(code(actual)).equal('not_git_repository');
  });

  it('should refuse an invalid branch name', async () => {
    // Arrange
    const base = await scenario('svc-create-bad-branch');

    // Act
    const actual = await error(adapter().create(request(base, { branch: '--force' })));

    // Assert
    should(code(actual)).equal('invalid_branch');
  });

  it('should refuse to combine an existing branch with a start point', async () => {
    // Arrange — silently ignoring the start point would put the session on the wrong commit.
    const base = await scenario('svc-create-conflicting');
    await setupGit(base.sourceCwd, 'branch', '--', 'feature/managed');

    // Act
    const actual = await error(adapter().create(request(base, { base: { kind: 'commit', reference: base.head } })));

    // Assert
    should(code(actual)).equal('invalid_branch');
    should((actual as WorktreeError).message).containEql('start point');
  });

  it('should refuse a managed repository directory that is not a plain directory', async () => {
    // Arrange
    const base = await scenario('svc-create-blocked');
    const first = await adapter().create(request(base));
    const repositoryDirectory = path.dirname(first.managed.path);
    await rm(repositoryDirectory, { recursive: true, force: true });
    await Bun.write(repositoryDirectory, 'not a directory');

    // Act
    const actual = await error(adapter().create(request(base, { branch: 'feature/second' })));

    // Assert
    should(code(actual)).equal('destination_exists');
    should((actual as WorktreeError).message).containEql('not a plain directory');
  });

  it('should refuse a destination that is already occupied', async () => {
    // Arrange
    const base = await scenario('svc-create-occupied');
    const first = await adapter().create(request(base));
    await rm(first.managed.path, { recursive: true, force: true });
    await mkdir(first.managed.path, { recursive: true });
    await setupGit(base.sourceCwd, 'worktree', 'prune');
    await setupGit(base.sourceCwd, 'branch', '--quiet', '-D', 'feature/managed');

    // Act
    const actual = await error(adapter().create(request(base)));

    // Assert
    should(code(actual)).equal('destination_exists');
    should((actual as WorktreeError).message).containEql('destination exists');
  });

  it('should refuse a checkout whose config would run a command during creation', async () => {
    // Arrange
    const base = await scenario('svc-create-filter');
    await setupGit(base.sourceCwd, 'config', '--local', 'filter.evil.process', 'touch pwned');

    // Act
    const actual = await error(adapter().create(request(base)));

    // Assert
    should(code(actual)).equal('unsafe_checkout_filter');
  });

  it('should preserve the checkout and say so when the requested cwd is absent from the branch', async () => {
    // Arrange — an uncommitted subdirectory does not exist on the new branch.
    const base = await scenario('svc-create-cwd');
    const subdirectory = path.join(base.sourceCwd, 'uncommitted');
    await mkdir(subdirectory, { recursive: true });

    // Act
    const actual = await error(adapter().create(request(base, { sourceCwd: subdirectory })));

    // Assert
    should(code(actual)).equal('verification_failed');
    should((actual as WorktreeError).message).containEql('the checkout was preserved');
  });

  it('should place the session in the same relative directory inside the new checkout', async () => {
    // Arrange
    const base = await scenario('svc-create-relative');
    await mkdir(path.join(base.sourceCwd, 'packages', 'app'), { recursive: true });
    await Bun.write(path.join(base.sourceCwd, 'packages', 'app', 'index.ts'), 'export {};\n');
    await setupGit(base.sourceCwd, 'add', '.');
    await setupGit(base.sourceCwd, 'commit', '--quiet', '-m', 'feat: app');

    // Act
    const actual = await adapter().create(request(base, { sourceCwd: path.join(base.sourceCwd, 'packages', 'app') }));

    // Assert
    should(actual.cwd).equal(path.join(actual.managed.path, 'packages', 'app'));
    should(await files.type(actual.cwd)).equal('directory');
  });

  it('should refuse when the source repository identity changes mid-flight', async () => {
    // Arrange
    const base = await scenario('svc-create-swapped');
    const other = await tempRepository('svc-create-swapped-other');
    let inspections = 0;
    const runner = new ScriptedGitRunner(invocation => {
      if (!invocation.args.includes('--git-common-dir')) return undefined;
      inspections += 1;
      return inspections === 2
        ? {
            exitCode: 0,
            stdout: new TextEncoder().encode(`${path.join(other.root, '.git')}\n`),
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
          }
        : undefined;
    });

    // Act
    const actual = await error(adapter(runner).create(request(base)));

    // Assert
    should(code(actual)).equal('verification_failed');
    should((actual as WorktreeError).message).containEql('identity changed');
  });

  it('should refuse a created checkout whose commit does not match the plan', async () => {
    // Arrange — Git lands the branch on an older commit than the plan resolved.
    const base = await scenario('svc-create-mismatch');
    await setupGit(base.sourceCwd, 'commit', '--quiet', '--allow-empty', '-m', 'feat: second');
    const second = (await setupGit(base.sourceCwd, 'rev-parse', 'HEAD')).trim();
    const runner = new ScriptedGitRunner(invocation =>
      invocation.args[0] === 'worktree' && invocation.args[1] === 'add'
        ? new BunGitRunner().run({
            ...invocation,
            args: invocation.args.map(argument => (argument === second ? base.head : argument)),
          })
        : undefined,
    );

    // Act
    const actual = await error(adapter(runner).create(request(base, { base: { kind: 'commit', reference: second } })));

    // Assert
    should(code(actual)).equal('verification_failed');
    should((actual as WorktreeError).message).containEql('did not match the plan');
  });

  it('should refuse a source renamed and replaced at the final create boundary', async () => {
    // Arrange — every ordinary check has passed when the pinner opens the source name
    const base = await scenario('svc-create-final-swap');
    const replacement = await tempRepository('svc-create-final-swap-replacement');
    const swap = new SwapBeforePin(base.sourceCwd, replacement.root);
    const plans: ManagedWorktreePlan[] = [];

    // Act
    const actual = await error(
      adapter(new BunGitRunner(), swap).create(
        request(base, {
          onPlanned: async plan => {
            plans.push(plan);
          },
        }),
      ),
    );

    // Assert — Git follows neither the symlink replacement nor a pathname reopened after validation
    should(code(actual)).equal('verification_failed');
    should((actual as WorktreeError).message).containEql('identity changed before worktree creation');
    should(plans).have.length(1);
    should(await files.type(plans[0]!.path)).equal('missing');
    should(await setupGit(replacement.root, 'branch', '--list', 'feature/managed')).equal('');
  });

  it('should serialise concurrent creation on the same repository', async () => {
    // Arrange
    const base = await scenario('svc-create-concurrent');
    const subject = adapter();

    // Act
    const results = await Promise.all([
      subject.create(request(base, { branch: 'feature/one', sessionId: 'session-a' })),
      subject.create(request(base, { branch: 'feature/two', sessionId: 'session-b' })),
    ]);

    // Assert
    should(results[0]?.managed.path).not.equal(results[1]?.managed.path);
    should(results.map(result => result.managed.branch).sort()).deepEqual(['feature/one', 'feature/two']);
  });

  it('should give exactly one winner when concurrent creates name the same branch', async () => {
    // Arrange
    const base = await scenario('svc-create-same-branch');
    const subject = adapter();

    // Act
    const results = await Promise.allSettled([
      subject.create(request(base, { branch: 'feature/one', sessionId: 'session-a' })),
      subject.create(request(base, { branch: 'feature/one', sessionId: 'session-b' })),
    ]);

    // Assert — the loser cannot create a second checkout or move the winner's branch
    should(results.filter(result => result.status === 'fulfilled')).have.length(1);
    const rejected = results.find(result => result.status === 'rejected');
    should(rejected?.status === 'rejected' ? code(rejected.reason) : undefined).equal('branch_in_use');
    const winner = results.find(
      (result): result is PromiseFulfilledResult<CreatedManagedWorktree> => result.status === 'fulfilled',
    );
    should(
      (await new GitWorktreeGateway(new BunGitRunner(), files, clock).inspect(winner!.value.managed.path)).branch,
    ).equal('feature/one');
    should(await new GitWorktreeGateway(new BunGitRunner(), files, clock).list(base.sourceCwd)).have.length(2);
  });
});

describe('ManagedWorktreeAdapter removal', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  const removalInput = (base: Scenario, managed: ManagedWorktree, overrides = {}) => ({
    managed,
    managedRoot: base.managedRoot,
    ownerActive: false,
    overrides: [] as readonly WorktreeRemovalOverride[],
    deleteBranch: false,
    ...overrides,
  });

  it('should remove a clean, pushed, owned checkout and keep its branch', async () => {
    // Arrange
    const base = await scenario('svc-remove');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const created = await adapter().create(request(base));

    // Act
    const decision = await checkRemoval(adapter(), removalInput(base, created.managed));
    const actual = await adapter().remove(removalInput(base, created.managed));

    // Assert
    should(decision.removable).be.true();
    should(actual.branchRetained).be.true();
    should(actual.branch).equal('feature/managed');
    should(await files.type(created.managed.path)).equal('missing');
  });

  it('should refuse to remove a checkout whose owning session is still running', async () => {
    // Arrange
    const base = await scenario('svc-remove-active');
    const created = await adapter().create(request(base));

    // Act
    const actual = await error(adapter().remove(removalInput(base, created.managed, { ownerActive: true })));

    // Assert
    should(code(actual)).equal('unsafe_remove');
    should((actual as WorktreeError).blockers.map(item => item.code)).containEql('active_session');
    should(await files.type(created.managed.path)).equal('directory');
  });

  it('should distinguish discardable working-tree changes from unpushed commits', async () => {
    // Arrange
    const base = await scenario('svc-remove-forces');
    const created = await adapter().create(request(base));
    await Bun.write(path.join(created.managed.path, 'README.md'), '# edited\n');

    // Act
    const actual = await checkRemoval(adapter(), removalInput(base, created.managed));

    // Assert — the two need different confirmations, because they lose different things.
    const overrides = new Map(actual.blockers.map(item => [item.code, item.override]));
    should(actual.removable).be.false();
    should(overrides.get('unstaged_changes')).equal('discard_worktree_changes');
    should(overrides.get('unpushed_commits')).equal('accept_unpushed_commits');
  });

  it('should refuse a checkout that the current working directory is inside', async () => {
    // Arrange
    const base = await scenario('svc-remove-cwd');
    const created = await adapter().create(request(base));

    // Act
    const actual = await checkRemoval(
      adapter(),
      removalInput(base, created.managed, { currentWorkingDirectory: path.join(created.managed.path, 'deep') }),
    );

    // Assert
    should(actual.blockers.map(item => item.code)).containEql('current_checkout');
  });

  it('should refuse a checkout another session or a live terminal still uses', async () => {
    // Arrange
    const base = await scenario('svc-remove-shared');
    const created = await adapter().create(request(base));

    // Act
    const actual = await checkRemoval(
      adapter(),
      removalInput(base, created.managed, {
        otherSessions: [{ id: 'session-9', cwd: created.managed.path }],
        liveTerminals: 2,
      }),
    );

    // Assert
    const codes = actual.blockers.map(item => item.code);
    should(codes).containEql('shared_checkout');
    should(codes).containEql('live_terminal');
  });

  it('should refuse a checkout whose ownership marker was removed', async () => {
    // Arrange
    const base = await scenario('svc-remove-unowned');
    const created = await adapter().create(request(base));
    await rm(path.join(created.managed.gitDir, 'worktree-owner'));

    // Act
    const actual = await checkRemoval(adapter(), removalInput(base, created.managed));

    // Assert
    should(actual.blockers.map(item => item.code)).containEql('ownership_mismatch');
  });

  it('should report an unreadable ownership marker as a Git error, not as absence', async () => {
    // Arrange
    const base = await scenario('svc-remove-marker-error');
    const created = await adapter().create(request(base));
    const marker = path.join(created.managed.gitDir, 'worktree-owner');
    await rm(marker);
    await mkdir(marker);

    // Act
    const actual = await checkRemoval(adapter(), removalInput(base, created.managed));

    // Assert
    should(actual.blockers.some(item => item.message.includes('ownership marker inspection failed'))).be.true();
  });

  it('should report a checkout that has already vanished as missing', async () => {
    // Arrange
    const base = await scenario('svc-remove-vanished');
    const created = await adapter().create(request(base));
    await rm(created.managed.path, { recursive: true, force: true });

    // Act
    const actual = await checkRemoval(adapter(), removalInput(base, created.managed));

    // Assert
    should(actual.removable).be.false();
    should(actual.blockers.map(item => item.code)).containEql('missing_worktree');
  });

  it('should report a dangling symlink in place of the checkout as unresolvable', async () => {
    // Arrange
    const base = await scenario('svc-remove-dangling');
    const created = await adapter().create(request(base));
    await rm(created.managed.path, { recursive: true, force: true });
    await symlink(path.join(created.managed.path, 'gone'), created.managed.path);

    // Act
    const actual = await checkRemoval(adapter(), removalInput(base, created.managed));

    // Assert
    should(actual.blockers.some(item => item.message.includes('checkout path inspection failed'))).be.true();
  });

  it('should record a managed root that cannot be resolved as a Git error', async () => {
    // Arrange
    const base = await scenario('svc-remove-root');
    const created = await adapter().create(request(base));
    const absentRoot = path.join(base.managedRoot, 'absent');

    // Act
    const actual = await checkRemoval(adapter(), { ...removalInput(base, created.managed), managedRoot: absentRoot });

    // Assert
    should(actual.blockers.some(item => item.message.includes('managed root inspection failed'))).be.true();
    should(actual.blockers.map(item => item.code)).containEql('outside_managed_root');
  });

  it('should refuse a checkout recorded outside the managed root', async () => {
    // Arrange
    const base = await scenario('svc-remove-escaped');
    const created = await adapter().create(request(base));
    const foreignRoot = await tempDirectory('svc-remove-foreign');

    // Act
    const actual = await checkRemoval(adapter(), { ...removalInput(base, created.managed), managedRoot: foreignRoot });

    // Assert
    should(actual.blockers.map(item => item.code)).containEql('outside_managed_root');
  });

  it('should turn a failed inspection into a blocker rather than a silent pass', async () => {
    // Arrange
    const base = await scenario('svc-remove-inspect-error');
    const created = await adapter().create(request(base));
    const runner = new ScriptedGitRunner(invocation =>
      invocation.args.includes('--absolute-git-dir')
        ? {
            exitCode: 128,
            stdout: new TextEncoder().encode(''),
            stderr: 'fatal: unreadable',
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
          }
        : undefined,
    );

    // Act
    const actual = await checkRemoval(adapter(runner), removalInput(base, created.managed));

    // Assert
    should(actual.removable).be.false();
    should(actual.blockers.some(item => item.message.includes('checkout inspection failed'))).be.true();
  });

  it('should turn a failed status or push-state query into blockers', async () => {
    // Arrange
    const base = await scenario('svc-remove-status-error');
    const created = await adapter().create(request(base));
    const failure = {
      exitCode: 128,
      stdout: new TextEncoder().encode(''),
      stderr: 'fatal: unreadable',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    };
    const runner = new ScriptedGitRunner(invocation =>
      invocation.args[0] === 'status' || invocation.args[0] === 'for-each-ref' ? failure : undefined,
    );

    // Act
    const actual = await checkRemoval(adapter(runner), removalInput(base, created.managed));

    // Assert
    const messages = actual.blockers.map(item => item.message);
    should(messages.some(message => message.includes('checkout status failed'))).be.true();
    should(messages.some(message => message.includes('push-state inspection failed'))).be.true();
  });

  it('should keep answering fail-closed when a late Git evidence read throws', async () => {
    // Arrange
    const base = await scenario('svc-remove-late-git-error');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'remote', 'set-head', 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const created = await adapter().create(request(base));
    await setupGit(created.managed.path, 'branch', '--set-upstream-to=origin/main', 'feature/managed');
    const cases = [
      [
        (args: readonly string[]) => args[0] === 'rev-list' && args.includes('--left-right'),
        'divergence inspection failed',
      ],
      [(args: readonly string[]) => args[0] === 'symbolic-ref', 'default-branch inspection failed'],
      [(args: readonly string[]) => args[0] === 'merge-base', 'integration inspection failed'],
    ] as const;

    // Act + Assert — each late failure becomes unforceable evidence instead of aborting the list
    for (const [matches, expected] of cases) {
      const runner = new ScriptedGitRunner(invocation => {
        if (matches(invocation.args)) throw new Error(`${invocation.args[0]} spawn failed`);
        return undefined;
      });
      const actual = await checkRemoval(adapter(runner), removalInput(base, created.managed));
      should(actual.removable).be.false();
      should(actual.blockers.some(item => item.message.includes(expected))).be.true();
    }
  });

  it('should abort the removal when the checkout changes between preflight and deletion', async () => {
    // Arrange — the second status query reports content the preflight did not see.
    const base = await scenario('svc-remove-raced');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const created = await adapter().create(request(base));
    let statuses = 0;
    const runner = new ScriptedGitRunner(invocation => {
      if (invocation.args[0] !== 'status') return undefined;
      statuses += 1;
      return statuses === 2
        ? {
            exitCode: 0,
            stdout: new TextEncoder().encode('? raced.txt\0'),
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
          }
        : undefined;
    });

    // Act
    const actual = await error(adapter(runner).remove(removalInput(base, created.managed)));

    // Assert
    should(code(actual)).equal('unsafe_remove');
    should((actual as WorktreeError).message).containEql('changed after the preflight');
    should(await files.type(created.managed.path)).equal('directory');
  });

  it('should refresh host occupancy inside the repository queue before deletion', async () => {
    // Arrange
    const base = await scenario('svc-remove-host-raced');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const created = await adapter().create(request(base));
    let refreshes = 0;

    // Act
    const actual = await error(
      adapter().remove({
        ...removalInput(base, created.managed),
        refreshEvidence: async () => {
          refreshes += 1;
          return { ...removalInput(base, created.managed), ownerActive: true };
        },
      }),
    );

    // Assert — a session that entered after the first preflight prevents the Git mutation
    should(code(actual)).equal('unsafe_remove');
    should((actual as WorktreeError).message).containEql('changed after the preflight');
    should(refreshes).equal(1);
    should(await files.type(created.managed.path)).equal('directory');
  });

  it('should refuse a checkout renamed and replaced at the final remove boundary', async () => {
    // Arrange — the replacement happens after both preflights, inside the final pin call
    const base = await scenario('svc-remove-final-swap');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const created = await adapter().create(request(base));
    const replacement = await tempRepository('svc-remove-final-swap-replacement');
    const swap = new SwapBeforePin(created.managed.path, replacement.root);

    // Act
    const actual = await error(adapter(new BunGitRunner(), swap).remove(removalInput(base, created.managed)));

    // Assert — the original checkout survives under its moved name and the replacement is untouched
    should(code(actual)).equal('unsafe_remove');
    should((actual as WorktreeError).message).containEql('identity changed at the mutation boundary');
    should(await files.type(swap.moved)).equal('directory');
    should(await files.type(created.managed.path)).equal('symlink');
    should(await Bun.file(path.join(replacement.root, 'README.md')).exists()).be.true();
  });
});

describe('ManagedWorktreeAdapter live refresh', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  const context = (base: Scenario, managed: ManagedWorktree) => ({
    managed,
    managedRoot: base.managedRoot,
    ownerActive: false,
  });

  it('should read where the checkout is NOW, not where the record says it started', async () => {
    // Arrange
    const base = await scenario('svc-live');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'remote', 'set-head', 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const created = await adapter().create(request(base));
    await setupGit(created.managed.path, 'commit', '--quiet', '--allow-empty', '-m', 'feat: moved on');
    await Bun.write(path.join(created.managed.path, 'untracked.txt'), 'new\n');
    const head = (await setupGit(created.managed.path, 'rev-parse', 'HEAD')).trim();

    // Act
    const actual = await adapter().examine(context(base, created.managed));

    // Assert — the record's `initialHead` and the live head are different facts
    should(actual.live.head).equal(head);
    should(actual.live.head).not.equal(created.managed.initialHead);
    should(actual.live.branch).equal('feature/managed');
    should(actual.live.detached).be.false();
    should(actual.live.status).match({ untracked: true, staged: false });
    should(actual.live.integrated).be.false();
    should(actual.live.locked).be.undefined();
    should(actual.decision.removable).be.false();
  });

  it('should count both directions against an upstream, and say so when there is none', async () => {
    // Arrange
    const base = await scenario('svc-live-divergence');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const tracked = await adapter().create(request(base, { branch: 'main-copy', sessionId: 'session-t' }));
    await setupGit(tracked.managed.path, 'branch', '--set-upstream-to', 'origin/main', 'main-copy');
    await setupGit(tracked.managed.path, 'commit', '--quiet', '--allow-empty', '-m', 'feat: ahead');
    const untracked = await adapter().create(request(base, { branch: 'lonely', sessionId: 'session-u' }));

    // Act
    const withUpstream = await adapter().examine(context(base, tracked.managed));
    const without = await adapter().examine(context(base, untracked.managed));

    // Assert — an unknown count is SAID, never shown as a zero nobody read
    should(withUpstream.live).match({ upstream: 'refs/remotes/origin/main', ahead: 1, behind: 0 });
    should(without.live.ahead).be.undefined();
    should(without.live.undetermined.join(' ')).containEql('no upstream is configured');
  });

  it('should report a locked checkout as locked rather than as removable', async () => {
    // Arrange
    const base = await scenario('svc-live-locked');
    const created = await adapter().create(request(base));
    await setupGit(base.sourceCwd, 'worktree', 'lock', '--reason', 'a release is running', '--', created.managed.path);

    // Act
    const actual = await adapter().examine(context(base, created.managed));

    // Assert
    should(actual.live.locked).equal('a release is running');
    should(actual.decision.blockers.map(item => item.code)).containEql('locked_worktree');
  });

  it('should say what it could not determine instead of leaving the gap silent', async () => {
    // Arrange — the checkout was deleted by hand under the daemon
    const base = await scenario('svc-live-missing');
    const created = await adapter().create(request(base));
    await rm(created.managed.path, { recursive: true, force: true });

    // Act
    const actual = await adapter().examine(context(base, created.managed));

    // Assert
    should(actual.live.undetermined).containEql('the checkout could not be inspected');
    should(actual.decision.removable).be.false();
    should(actual.branchEvidence).be.undefined();
  });

  it('should still answer when the checkout is deleted midway through one refresh', async () => {
    // Arrange — a real `rm -rf` lands between two reads of the SAME refresh, which is the race the
    // uncached refresh exists for. Nothing here is stubbed: the runner is only the clock, and every
    // failure below is the real Git runner refusing to start in a directory that is genuinely gone.
    const base = await scenario('svc-live-vanished');
    const created = await adapter().create(request(base));
    const runner = new ScriptedGitRunner(invocation => {
      if (invocation.args[0] === 'symbolic-ref') rmSync(created.managed.path, { recursive: true, force: true });
      return undefined;
    });

    // Act — the checkout is read, and disappears before its integration target and its siblings are
    const actual = await adapter(runner).examine(context(base, created.managed));

    // Assert — every read it could not complete is NAMED, and the document fails closed on all of them
    const undetermined = actual.live.undetermined.join('\n');
    should(undetermined).match(/default-branch inspection failed:/u);
    should(undetermined).match(/checkout enumeration failed:/u);
    should(actual.live.undetermined).containEql('no integration target could be resolved, so integration is unproven');
    should(actual.live.integrated).be.undefined();
    should(actual.branchEvidence).match({ protectedBranch: false, checkedOut: false, integrated: false });
    should(actual.decision.removable).be.false();
  });

  it('should price the branch deletion on the CHECK, before anything is authorized', async () => {
    // Arrange
    const base = await scenario('svc-live-branch-price');
    const created = await adapter().create(request(base));

    // Act
    const actual = await adapter().examine(context(base, created.managed));

    // Assert
    should(actual.decision.branchDeletion?.deletable).be.false();
    should(actual.decision.branchDeletion?.blockers.map(item => item.code)).containEql('unmerged_branch');
    should(actual.branchEvidence).match({ branchPreexisted: false, checkedOut: false });
  });

  it('should treat the branch the repository defaults to as protected', async () => {
    // Arrange — a managed checkout of the very branch `origin/HEAD` names
    const base = await scenario('svc-live-protected');
    await setupGit(base.sourceCwd, 'branch', '--', 'release');
    await tempRemote(base.sourceCwd, 'origin', 'release');
    await setupGit(base.sourceCwd, 'remote', 'set-head', 'origin', 'release');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const defaulted = await adapter().create(request(base, { branch: 'release', sessionId: 'session-r' }));
    const ordinary = await adapter().create(request(base, { branch: 'feature/managed', sessionId: 'session-o' }));

    // Act
    const onDefault = await adapter().examine(context(base, defaulted.managed));
    const onOwn = await adapter().examine(context(base, ordinary.managed));

    // Assert — deleting the branch a repository defaults to is refused by nothing else
    should(onDefault.branchEvidence?.protectedBranch).be.true();
    should(onDefault.decision.branchDeletion?.blockers.map(item => item.code)).containEql('protected_branch');
    should(onOwn.branchEvidence?.protectedBranch).be.false();
    should(onOwn.branchEvidence?.commitsPushed).be.true();
  });
});

describe('ManagedWorktreeAdapter consent and branch deletion', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  const removal = (base: Scenario, managed: ManagedWorktree, overrides: Record<string, unknown> = {}) => ({
    managed,
    managedRoot: base.managedRoot,
    ownerActive: false,
    overrides: [] as readonly WorktreeRemovalOverride[],
    deleteBranch: false,
    ...overrides,
  });

  it('should destroy a dirty checkout only once the matching consent was given', async () => {
    // Arrange
    const base = await scenario('svc-consent-dirty');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const created = await adapter().create(request(base));
    await Bun.write(path.join(created.managed.path, 'README.md'), '# edited\n');

    // Act
    const refused = await error(adapter().remove(removal(base, created.managed)));
    const wrongConsent = await error(
      adapter().remove(removal(base, created.managed, { overrides: ['accept_unpushed_commits'] })),
    );
    const accepted = await adapter().remove(
      removal(base, created.managed, { overrides: ['discard_worktree_changes'] }),
    );

    // Assert — one flag never clears a class of loss it does not name
    should(code(refused)).equal('unsafe_remove');
    should(code(wrongConsent)).equal('unsafe_remove');
    should((wrongConsent as WorktreeError).blockers.map(item => item.code)).containEql('unstaged_changes');
    should(accepted.branchRetained).be.true();
    should(await files.type(created.managed.path)).equal('missing');
  });

  it('should never let any consent clear a blocker that names no override', async () => {
    // Arrange
    const base = await scenario('svc-consent-unforceable');
    const created = await adapter().create(request(base));

    // Act
    const actual = await error(
      adapter().remove(
        removal(base, created.managed, {
          ownerActive: true,
          overrides: ['discard_worktree_changes', 'accept_unpushed_commits'],
        }),
      ),
    );

    // Assert
    should(code(actual)).equal('unsafe_remove');
    should((actual as WorktreeError).blockers.map(item => item.code)).containEql('active_session');
    should(await files.type(created.managed.path)).equal('directory');
  });

  it('should judge a pushed feature against the default branch and retain it while unmerged', async () => {
    // Arrange — the feature tracks its same-name upstream but is not in origin/main
    const base = await scenario('svc-pushed-unmerged');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'remote', 'set-head', 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const subject = adapter();
    const created = await subject.create(request(base));
    await setupGit(created.managed.path, 'commit', '--quiet', '--allow-empty', '-m', 'feat: pushed but unmerged');
    await setupGit(created.managed.path, 'push', '--quiet', '--set-upstream', 'origin', 'feature/managed');

    // Act
    const inspected = await subject.examine(removal(base, created.managed));
    const removed = await subject.remove(removal(base, created.managed, { deleteBranch: true }));

    // Assert — publication to origin/feature/managed is not integration into origin/main
    should(inspected.live.upstream).equal('refs/remotes/origin/feature/managed');
    should(inspected.live.integrated).be.false();
    should(inspected.decision.branchDeletion?.blockers.map(item => item.code)).containEql('unmerged_branch');
    should(removed.branchRetained).be.true();
    should(removed.branchBlockers.map(item => item.code)).eql(['unmerged_branch']);
    should(await setupGit(base.sourceCwd, 'branch', '--list', 'feature/managed')).containEql('feature/managed');
  });

  it('should tombstone the removed checkout and report a branch-delete Git failure as retained', async () => {
    // Arrange
    const base = await scenario('svc-branch-delete-fails');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'remote', 'set-head', 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const failure = {
      exitCode: 128,
      stdout: new Uint8Array(),
      stderr: 'fatal: branch deletion failed after checkout removal',
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
    };
    const runner = new ScriptedGitRunner(invocation =>
      invocation.args[0] === 'branch' && (invocation.args[1] === '-d' || invocation.args[1] === '-D')
        ? failure
        : undefined,
    );
    const subject = adapter(runner);
    const created = await subject.create(request(base));

    // Act
    const removed = await subject.remove(
      removal(base, created.managed, {
        deleteBranch: true,
        confirmations: ['delete_unmerged_branch'],
      }),
    );

    // Assert — the checkout operation succeeded; only the independently requested branch step failed
    should(await files.type(created.managed.path)).equal('missing');
    should(removed.branchRetained).be.true();
    should(removed.branchBlockers).match([
      { code: 'git_error', message: /branch deletion failed: git branch delete failed/u },
    ]);
    should(await setupGit(base.sourceCwd, 'branch', '--list', 'feature/managed')).containEql('feature/managed');
  });

  it('should report the branch deleted when Git times out only after deleting its ref', async () => {
    // Arrange
    const base = await scenario('svc-branch-delete-timeout');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'remote', 'set-head', 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const created = await adapter().create(request(base));
    const runner = new (class implements GitRunner {
      async run(invocation: GitInvocation): Promise<GitExecution> {
        const execution = await new BunGitRunner().run(invocation);
        return invocation.args[0] === 'branch' && (invocation.args[1] === '-d' || invocation.args[1] === '-D')
          ? { ...execution, exitCode: 124, timedOut: true, stderr: 'timed out after deleting the ref' }
          : execution;
      }
    })();

    // Act
    const removed = await adapter(runner).remove(
      removal(base, created.managed, { deleteBranch: true, confirmations: ['delete_unmerged_branch'] }),
    );

    // Assert — the command outcome was ambiguous, but the held-repository ref probe was not
    should(removed.branchRetained).be.false();
    should(removed.branchBlockers).match([{ code: 'git_error', message: /timed out/u }]);
    should(await setupGit(base.sourceCwd, 'branch', '--list', 'feature/managed')).equal('');
  });

  it('should preserve the proven deleted outcome when releasing the repository pin fails', async () => {
    // Arrange
    const base = await scenario('svc-branch-delete-close-fails');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'remote', 'set-head', 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const created = await adapter().create(request(base));
    const delegate = directoryPinner();
    const pinner: WorktreeDirectoryPinner = {
      pin: async cwd => {
        const pinned = await delegate.pin(cwd);
        return {
          rootReal: pinned.rootReal,
          policyCwd: pinned.policyCwd,
          close: async () => {
            await pinned.close();
            if (path.resolve(cwd) === path.resolve(created.managed.repositoryRoot)) {
              throw new Error('repository pin close failed');
            }
          },
        };
      },
    };

    // Act
    const removed = await adapter(new BunGitRunner(), pinner).remove(
      removal(base, created.managed, { deleteBranch: true, confirmations: ['delete_unmerged_branch'] }),
    );

    // Assert
    should(removed.branchRetained).be.false();
    should(removed.branchBlockers).match([{ code: 'git_error', message: /repository pin close failed/u }]);
    should(await setupGit(base.sourceCwd, 'branch', '--list', 'feature/managed')).equal('');
  });

  it('should refuse to invent a branch outcome when the final ref probe fails', async () => {
    // Arrange
    const base = await scenario('svc-branch-delete-probe-fails');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'remote', 'set-head', 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const created = await adapter().create(request(base));
    const runner = new ScriptedGitRunner(invocation => {
      if (invocation.args[0] === 'show-ref') throw new Error('ref store became unreadable');
      return undefined;
    });

    // Act
    const actual = await error(
      adapter(runner).remove(
        removal(base, created.managed, { deleteBranch: true, confirmations: ['delete_unmerged_branch'] }),
      ),
    );

    // Assert — the checkout result remains observable, while the branch state is explicitly unknown
    should(code(actual)).equal('verification_failed');
    should((actual as WorktreeError).message).containEql('branch outcome is unknown');
    should(await files.type(created.managed.path)).equal('missing');
  });

  it('should keep the branch and name every blocker when the confirmations fall short', async () => {
    // Arrange
    const base = await scenario('svc-branch-kept');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const created = await adapter().create(request(base));
    // A commit that exists nowhere else, so keeping the branch is the only safe answer.
    await setupGit(created.managed.path, 'commit', '--quiet', '--allow-empty', '-m', 'feat: mine alone');

    // Act
    const actual = await adapter().remove(
      removal(base, created.managed, { deleteBranch: true, overrides: ['accept_unpushed_commits'] }),
    );

    // Assert — a removal that silently kept the branch is what made `--delete-branch` a dead flag
    should(actual.branchRetained).be.true();
    should(actual.branchBlockers.map(item => item.code)).containEql('unmerged_branch');
    should(await setupGit(base.sourceCwd, 'branch', '--list', 'feature/managed')).containEql('feature/managed');
  });

  it('should really delete the branch once every reason to keep it was confirmed', async () => {
    // Arrange
    const base = await scenario('svc-branch-deleted');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const created = await adapter().create(request(base));
    await setupGit(created.managed.path, 'commit', '--quiet', '--allow-empty', '-m', 'feat: mine alone');

    // Act
    const actual = await adapter().remove(
      removal(base, created.managed, {
        deleteBranch: true,
        overrides: ['accept_unpushed_commits'],
        confirmations: ['delete_unpushed_branch', 'delete_unmerged_branch'],
      }),
    );

    // Assert
    should(actual.branchRetained).be.false();
    should(actual.branchBlockers).be.empty();
    should(await setupGit(base.sourceCwd, 'branch', '--list', 'feature/managed')).equal('');
  });

  it('should refuse to delete a branch another checkout still holds, whatever was confirmed', async () => {
    // Arrange
    const base = await scenario('svc-branch-elsewhere');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const created = await adapter().create(request(base));
    // A second checkout of the SAME branch, made outside the managed root.
    const rival = path.join(await tempDirectory('svc-branch-rival'), 'checkout');
    await setupGit(created.managed.path, 'switch', '--quiet', '--detach', 'HEAD');
    await setupGit(base.sourceCwd, 'worktree', 'add', '--', rival, 'feature/managed');
    await setupGit(created.managed.path, 'switch', '--quiet', 'feature/managed').catch(() => undefined);

    // Act
    const actual = await error(
      adapter().remove(
        removal(base, created.managed, {
          deleteBranch: true,
          confirmations: ['delete_unpushed_branch', 'delete_unmerged_branch'],
        }),
      ),
    );

    // Assert — the branch is still checked out somewhere, and no confirmation clears that
    should(code(actual)).equal('unsafe_remove');
    should(await setupGit(base.sourceCwd, 'branch', '--list', 'feature/managed')).containEql('feature/managed');
  });
});

describe('ManagedWorktreeAdapter recovery from an interrupted creation', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  const intentFor = (plan: ManagedWorktreePlan, token = TOKEN): ManagedWorktreeIntent => ({
    version: 1,
    path: plan.path,
    branch: plan.branch,
    repositoryRoot: plan.repositoryRoot,
    commonDir: plan.commonDir,
    ownershipToken: token,
    declaredAt: '2026-08-04T00:00:00.000Z',
    initialHead: plan.startOid,
    branchPreexisted: plan.branchPreexisted,
    sourceCwd: plan.sourceCwd,
    relativeCwd: plan.relativeCwd,
    ownerSessionId: 'session-1',
  });

  it('should adopt a checkout that is there and proves it is ours', async () => {
    // Arrange — the daemon died after `worktree add` and before the record was filed
    const base = await scenario('svc-adopt');
    const planned: ManagedWorktreePlan[] = [];
    const created = await adapter().create(request(base, { onPlanned: async plan => void planned.push(plan) }));

    // Act
    const actual = await adapter().adopt(intentFor(planned[0]!));

    // Assert — the adopted record carries the gitDir only Git could supply
    should(actual.kind).equal('adopted');
    should(actual.kind === 'adopted' ? actual.managed : undefined).match({
      path: created.managed.path,
      gitDir: created.managed.gitDir,
      branch: 'feature/managed',
      ownerSessionId: 'session-1',
      relativeCwd: '',
    });
  });

  it('should report a declared checkout Git never made as simply absent', async () => {
    // Arrange
    const base = await scenario('svc-adopt-absent');
    const planned: ManagedWorktreePlan[] = [];
    await adapter()
      .create(
        request(base, {
          onPlanned: async plan => {
            planned.push(plan);
            throw new Error('the daemon died here');
          },
        }),
      )
      .catch(() => undefined);

    // Act
    const actual = await adapter().adopt(intentFor(planned[0]!));

    // Assert
    should(actual.kind).equal('absent');
  });

  it('should refuse to adopt something at that path it cannot prove it made', async () => {
    // Arrange
    const base = await scenario('svc-adopt-unverified');
    const planned: ManagedWorktreePlan[] = [];
    const created = await adapter().create(request(base, { onPlanned: async plan => void planned.push(plan) }));
    const plan = planned[0]!;

    // Act — an ordinary directory, and a real checkout whose marker is somebody else's token
    const strangerRoot = path.join(await tempDirectory('svc-adopt-stranger'), 'checkout');
    await mkdir(strangerRoot, { recursive: true });
    const notARepository = await adapter().adopt(intentFor({ ...plan, path: strangerRoot }));
    const wrongToken = await adapter().adopt(intentFor(plan, 'someone-elses-token'));

    // Assert — adopting either would hand `git worktree remove` a directory this daemon does not own
    should(notARepository.kind).equal('unverified');
    should(wrongToken).match({ kind: 'unverified', reason: /ownership marker/u });
    should(await files.type(created.managed.path)).equal('directory');
  });

  it('should contain an inspection that fails outright rather than let it escape', async () => {
    // Arrange — two occupants Git cannot even be STARTED in: a plain file, and a symlink pointing at
    // nothing. Both exist, so the `absent` answer above does not cover either of them.
    const base = await scenario('svc-adopt-uninspectable');
    const planned: ManagedWorktreePlan[] = [];
    await adapter().create(request(base, { onPlanned: async plan => void planned.push(plan) }));
    const plan = planned[0]!;
    const occupied = await tempDirectory('svc-adopt-uninspectable-path');
    const asFile = path.join(occupied, 'checkout');
    const dangling = path.join(occupied, 'dangling');
    await Bun.write(asFile, 'not a checkout\n');
    await symlink(path.join(occupied, 'gone'), dangling, 'dir');

    // Act
    const file = await adapter().adopt(intentFor({ ...plan, path: asFile }));
    const broken = await adapter().adopt(intentFor({ ...plan, path: dangling }));

    // Assert — a failed inspection is REPORTED as unverified, not thrown and not silently adopted,
    // and whatever holds the path is left exactly where it was
    should(file).match({ kind: 'unverified', reason: /is not a linked worktree of/u });
    should(broken).match({ kind: 'unverified', reason: /is not a linked worktree of/u });
    should(await files.type(asFile)).equal('file');
    should(await files.type(dangling)).equal('symlink');
  });

  it('should answer whether the exact recorded checkout incarnation is still at its path', async () => {
    // Arrange
    const base = await scenario('svc-exists');
    const created = await adapter().create(request(base));

    // Act
    const before = await adapter().presence(created.managed);
    await rm(created.managed.path, { recursive: true, force: true });
    const after = await adapter().presence(created.managed);

    // Assert — an interrupted removal distinguishes its checkout from mere pathname occupancy
    should(before.kind).equal('owned');
    should(after.kind).equal('absent');
  });

  it('should not treat a symlink replacement as the interrupted checkout surviving', async () => {
    // Arrange
    const base = await scenario('svc-presence-replaced');
    const created = await adapter().create(request(base));
    const replacement = await tempRepository('svc-presence-replacement');
    await rename(created.managed.path, `${created.managed.path}.moved`);
    await symlink(replacement.root, created.managed.path, 'dir');

    // Act
    const actual = await adapter().presence(created.managed);

    // Assert
    should(actual).match({ kind: 'unverified', reason: /symlink/u });
  });
});
