import { afterAll, describe, it } from 'bun:test';
import { mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { BunGitRunner } from '../../../src/adapters/git/index.ts';
import {
  GitWorktreeGateway,
  ManagedWorktreeAdapter,
  NodeWorktreeFileSystem,
  SystemWorktreeClock,
  WorktreeAdapterError,
  WorktreeOperationQueue,
} from '../../../src/adapters/worktrees/index.ts';
import type { GitExecution, GitInvocation, GitRunner } from '../../../src/lib/worktrees/ports.ts';
import type {
  CreateManagedWorktreeInput,
  ManagedWorktree,
  ManagedWorktreePlan,
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

const adapter = (runner: GitRunner = new BunGitRunner()): ManagedWorktreeAdapter =>
  new ManagedWorktreeAdapter(new GitWorktreeGateway(runner, files, clock), files, clock, new WorktreeOperationQueue());

const error = async (operation: Promise<unknown>): Promise<unknown> =>
  await operation.then(() => undefined).catch((thrown: unknown) => thrown);

const code = (thrown: unknown): string | undefined => (thrown as WorktreeAdapterError | undefined)?.code;

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
    const actual = await adapter().create(request(base, { startPoint: `  ${base.head}  ` }));

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
    should((actual as WorktreeAdapterError).message).containEql(other);
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
    const actual = await error(adapter().create(request(base, { startPoint: base.head })));

    // Assert
    should(code(actual)).equal('invalid_branch');
    should((actual as WorktreeAdapterError).message).containEql('start point');
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
    should((actual as WorktreeAdapterError).message).containEql('not a plain directory');
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
    should((actual as WorktreeAdapterError).message).containEql('destination exists');
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
    should((actual as WorktreeAdapterError).message).containEql('the checkout was preserved');
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
    should((actual as WorktreeAdapterError).message).containEql('identity changed');
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
    const actual = await error(adapter(runner).create(request(base, { startPoint: second })));

    // Assert
    should(code(actual)).equal('verification_failed');
    should((actual as WorktreeAdapterError).message).containEql('did not match the plan');
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
});

describe('ManagedWorktreeAdapter removal', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  const removalInput = (base: Scenario, managed: ManagedWorktree, overrides = {}) => ({
    managed,
    managedRoot: base.managedRoot,
    ownerActive: false,
    ...overrides,
  });

  it('should remove a clean, pushed, owned checkout and keep its branch', async () => {
    // Arrange
    const base = await scenario('svc-remove');
    await tempRemote(base.sourceCwd, 'origin', 'main');
    await setupGit(base.sourceCwd, 'fetch', '--quiet', 'origin');
    const created = await adapter().create(request(base));

    // Act
    const decision = await adapter().checkRemoval(removalInput(base, created.managed));
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
    should((actual as WorktreeAdapterError).blockers.map(item => item.code)).containEql('active_session');
    should(await files.type(created.managed.path)).equal('directory');
  });

  it('should distinguish discardable working-tree changes from unpushed commits', async () => {
    // Arrange
    const base = await scenario('svc-remove-forces');
    const created = await adapter().create(request(base));
    await Bun.write(path.join(created.managed.path, 'README.md'), '# edited\n');

    // Act
    const actual = await adapter().checkRemoval(removalInput(base, created.managed));

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
    const actual = await adapter().checkRemoval(
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
    const actual = await adapter().checkRemoval(
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
    const actual = await adapter().checkRemoval(removalInput(base, created.managed));

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
    const actual = await adapter().checkRemoval(removalInput(base, created.managed));

    // Assert
    should(actual.blockers.some(item => item.message.includes('ownership marker inspection failed'))).be.true();
  });

  it('should report a checkout that has already vanished as missing', async () => {
    // Arrange
    const base = await scenario('svc-remove-vanished');
    const created = await adapter().create(request(base));
    await rm(created.managed.path, { recursive: true, force: true });

    // Act
    const actual = await adapter().checkRemoval(removalInput(base, created.managed));

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
    const actual = await adapter().checkRemoval(removalInput(base, created.managed));

    // Assert
    should(actual.blockers.some(item => item.message.includes('checkout path inspection failed'))).be.true();
  });

  it('should record a managed root that cannot be resolved as a Git error', async () => {
    // Arrange
    const base = await scenario('svc-remove-root');
    const created = await adapter().create(request(base));
    const absentRoot = path.join(base.managedRoot, 'absent');

    // Act
    const actual = await adapter().checkRemoval({ ...removalInput(base, created.managed), managedRoot: absentRoot });

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
    const actual = await adapter().checkRemoval({ ...removalInput(base, created.managed), managedRoot: foreignRoot });

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
    const actual = await adapter(runner).checkRemoval(removalInput(base, created.managed));

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
    const actual = await adapter(runner).checkRemoval(removalInput(base, created.managed));

    // Assert
    const messages = actual.blockers.map(item => item.message);
    should(messages.some(message => message.includes('checkout status failed'))).be.true();
    should(messages.some(message => message.includes('push-state inspection failed'))).be.true();
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
    should((actual as WorktreeAdapterError).message).containEql('changed after preflight');
    should(await files.type(created.managed.path)).equal('directory');
  });
});
