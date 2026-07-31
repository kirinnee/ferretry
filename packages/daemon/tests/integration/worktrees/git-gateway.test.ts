import { afterAll, describe, it } from 'bun:test';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { BunGitRunner } from '../../../src/adapters/git/index.ts';
import {
  GitWorktreeGateway,
  NodeWorktreeFileSystem,
  SystemWorktreeClock,
  WorktreeAdapterError,
} from '../../../src/adapters/worktrees/index.ts';
import type { GitExecution, GitInvocation, GitRunner } from '../../../src/lib/worktrees/ports.ts';
import { cleanupTempDirectories, setupGit, tempDirectory, tempRemote, tempRepository } from '../support/repository.ts';

const files = new NodeWorktreeFileSystem();
const clock = new SystemWorktreeClock();

const gateway = (runner: GitRunner = new BunGitRunner()): GitWorktreeGateway =>
  new GitWorktreeGateway(runner, files, clock);

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const execution = (overrides: Partial<GitExecution> = {}): GitExecution => ({
  exitCode: 0,
  stdout: encode(''),
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
  ...overrides,
});

/** A stand-in for Git that replays crafted results, so defensive paths are reachable. */
class ScriptedGitRunner implements GitRunner {
  readonly invocations: GitInvocation[] = [];

  constructor(private readonly reply: (invocation: GitInvocation) => GitExecution | undefined) {}

  async run(invocation: GitInvocation): Promise<GitExecution> {
    this.invocations.push(invocation);
    const scripted = this.reply(invocation);
    return scripted ?? (await new BunGitRunner().run(invocation));
  }
}

const error = async (operation: Promise<unknown>): Promise<unknown> =>
  await operation.then(() => undefined).catch((thrown: unknown) => thrown);

describe('GitWorktreeGateway list and inspect', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  it('should list the main checkout and every linked worktree', async () => {
    // Arrange
    const repository = await tempRepository('gw-list');
    const linked = path.join(await tempDirectory('gw-list-linked'), 'wt');
    await setupGit(repository.root, 'worktree', 'add', '-b', 'feature/one', '--', linked);

    // Act
    const actual = await gateway().list(repository.root);

    // Assert
    should(actual).have.length(2);
    should(actual[0]?.path).equal(repository.root);
    should(actual[0]?.branch).equal('main');
    should(actual[0]?.detached).be.false();
    should(actual[1]?.branch).equal('feature/one');
  });

  it('should refuse a truncated worktree listing rather than parse a partial answer', async () => {
    // Arrange
    const repository = await tempRepository('gw-truncated');
    const runner = new ScriptedGitRunner(invocation =>
      invocation.args[0] === 'worktree'
        ? execution({ stdout: encode('worktree /a\0'), stdoutTruncated: true })
        : undefined,
    );

    // Act
    const actual = await error(gateway(runner).list(repository.root));

    // Assert
    should(actual).be.instanceof(WorktreeAdapterError);
    should((actual as WorktreeAdapterError).code).equal('verification_failed');
    should((actual as WorktreeAdapterError).message).containEql('truncated');
  });

  it('should report a path that does not exist as missing without running Git', async () => {
    // Arrange
    const root = await tempDirectory('gw-missing');
    const runner = new ScriptedGitRunner(() => undefined);

    // Act
    const actual = await gateway(runner).inspect(path.join(root, 'absent'));

    // Assert
    should(actual.repo).be.false();
    should(actual.kind).equal('missing');
    should(actual.observedAt).not.be.empty();
    should(runner.invocations).be.empty();
  });

  it('should report a plain directory as not a repository', async () => {
    // Arrange
    const root = await tempDirectory('gw-not-git');

    // Act
    const actual = await gateway().inspect(root);

    // Assert
    should(actual.repo).be.false();
    should(actual.kind).equal('not_git');
  });

  it('should report a bare repository as not a work tree', async () => {
    // Arrange
    const root = await tempDirectory('gw-bare');
    await setupGit(root, 'init', '--bare', '--quiet', '-b', 'main');

    // Act
    const actual = await gateway().inspect(root);

    // Assert
    should(actual.repo).be.false();
    should(actual.kind).equal('not_git');
  });

  it('should surface an unexpected rev-parse failure instead of calling it "not a repository"', async () => {
    // Arrange
    const root = await tempDirectory('gw-rev-parse');
    const runner = new ScriptedGitRunner(invocation =>
      invocation.args[0] === 'rev-parse' ? execution({ exitCode: 128, stderr: 'fatal: disk on fire' }) : undefined,
    );

    // Act
    const actual = await error(gateway(runner).inspect(root));

    // Assert
    should((actual as Error).message).equal('git rev-parse failed: fatal: disk on fire');
  });

  it('should describe the main checkout with its own Git directory', async () => {
    // Arrange
    const repository = await tempRepository('gw-main');

    // Act
    const actual = await gateway().inspect(repository.root);

    // Assert
    should(actual.repo).be.true();
    should(actual.kind).equal('main_checkout');
    should(actual.worktreeRoot).equal(repository.root);
    should(actual.repositoryRoot).equal(repository.root);
    should(actual.gitDir).equal(path.join(repository.root, '.git'));
    should(actual.commonDir).equal(path.join(repository.root, '.git'));
    should(actual.branch).equal('main');
    should(actual.detached).be.false();
    should(actual.head).equal(repository.head);
    should(actual.locked).be.undefined();
  });

  it('should describe a linked worktree, its shared common directory, and a lock', async () => {
    // Arrange
    const repository = await tempRepository('gw-linked');
    const linked = path.join(await tempDirectory('gw-linked-child'), 'wt');
    await setupGit(repository.root, 'worktree', 'add', '-b', 'feature/two', '--', linked);
    await setupGit(repository.root, 'worktree', 'lock', '--reason', 'in use', '--', linked);

    // Act
    const actual = await gateway().inspect(linked);

    // Assert
    should(actual.kind).equal('linked_worktree');
    should(actual.repositoryRoot).equal(repository.root);
    should(actual.commonDir).equal(path.join(repository.root, '.git'));
    should(actual.gitDir).not.equal(actual.commonDir);
    should(actual.branch).equal('feature/two');
    should(actual.locked).equal('in use');
  });

  it('should describe a detached checkout as detached', async () => {
    // Arrange
    const repository = await tempRepository('gw-detached');
    const linked = path.join(await tempDirectory('gw-detached-child'), 'wt');
    await setupGit(repository.root, 'worktree', 'add', '--detach', '--', linked, repository.head);

    // Act
    const actual = await gateway().inspect(linked);

    // Assert
    should(actual.detached).be.true();
    should(actual.branch).be.undefined();
  });

  it('should ignore a stale worktree record whose directory has been deleted', async () => {
    // Arrange — the record survives deletion until `git worktree prune` runs.
    const repository = await tempRepository('gw-stale');
    const linked = path.join(await tempDirectory('gw-stale-child'), 'wt');
    await setupGit(repository.root, 'worktree', 'add', '-b', 'feature/stale', '--', linked);
    await rm(linked, { recursive: true, force: true });

    // Act
    const actual = await gateway().inspect(repository.root);

    // Assert
    should(actual.kind).equal('main_checkout');
    should(actual.worktreeRoot).equal(repository.root);
  });

  it('should refuse a listing that does not contain the checkout Git just reported', async () => {
    // Arrange
    const repository = await tempRepository('gw-absent-record');
    const runner = new ScriptedGitRunner(invocation =>
      invocation.args[0] === 'worktree' ? execution({ stdout: encode('worktree /nowhere\0\0') }) : undefined,
    );

    // Act
    const actual = await error(gateway(runner).inspect(repository.root));

    // Assert
    should((actual as WorktreeAdapterError).code).equal('verification_failed');
    should((actual as WorktreeAdapterError).message).containEql('did not list the current checkout');
  });
});

describe('GitWorktreeGateway branch and commit resolution', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  it('should accept a well-formed branch name', async () => {
    // Arrange
    const repository = await tempRepository('gw-branch-ok');

    // Act
    const actual = await gateway().validateBranch(repository.root, '  feature/ok  ');

    // Assert
    should(actual).equal('feature/ok');
  });

  it.each([
    { label: 'empty', branch: '   ' },
    { label: 'flag-like', branch: '--force' },
    { label: 'NUL-bearing', branch: 'feature\0injected' },
    { label: 'malformed', branch: 'feature//bad' },
    { label: 'space-bearing', branch: 'feature branch' },
    { label: 'ref-relative', branch: '@{-1}' },
  ])('should refuse a $label branch name', async ({ branch }) => {
    // Arrange
    const repository = await tempRepository('gw-branch-bad');

    // Act
    const actual = await error(gateway().validateBranch(repository.root, branch));

    // Assert
    should(actual).be.instanceof(WorktreeAdapterError);
    should((actual as WorktreeAdapterError).code).equal('invalid_branch');
  });

  it('should refuse a branch name Git rewrites into something else', async () => {
    // Arrange — a normalising answer means the name was never literal.
    const repository = await tempRepository('gw-branch-nonliteral');
    const runner = new ScriptedGitRunner(invocation =>
      invocation.args[0] === 'check-ref-format' ? execution({ stdout: encode('rewritten\n') }) : undefined,
    );

    // Act
    const actual = await error(gateway(runner).validateBranch(repository.root, 'feature/ok'));

    // Assert
    should((actual as WorktreeAdapterError).code).equal('invalid_branch');
    should((actual as WorktreeAdapterError).message).containEql('is not literal');
  });

  it('should distinguish an existing local branch from an absent one', async () => {
    // Arrange
    const repository = await tempRepository('gw-local-branch');
    await setupGit(repository.root, 'branch', '--', 'feature/exists');

    // Act
    const present = await gateway().localBranchExists(repository.root, 'feature/exists');
    const absent = await gateway().localBranchExists(repository.root, 'feature/absent');

    // Assert
    should(present).be.true();
    should(absent).be.false();
  });

  it('should raise a show-ref failure that is not a plain "no such ref"', async () => {
    // Arrange
    const repository = await tempRepository('gw-show-ref');
    const runner = new ScriptedGitRunner(invocation =>
      invocation.args[0] === 'show-ref' ? execution({ exitCode: 128, stderr: 'fatal: broken index' }) : undefined,
    );

    // Act
    const actual = await error(gateway(runner).localBranchExists(repository.root, 'main'));

    // Assert
    should((actual as Error).message).equal('git show-ref failed: fatal: broken index');
  });

  it('should find every remote carrying a branch and ignore remote HEAD', async () => {
    // Arrange
    const repository = await tempRepository('gw-remotes');
    await tempRemote(repository.root, 'origin', 'main');
    await tempRemote(repository.root, 'upstream', 'main');
    await setupGit(repository.root, 'fetch', '--quiet', '--all');

    // Act
    const found = await gateway().remoteBranchCandidates(repository.root, 'main');
    const missing = await gateway().remoteBranchCandidates(repository.root, 'absent');

    // Assert
    should([...found].sort()).deepEqual(['refs/remotes/origin/main', 'refs/remotes/upstream/main']);
    should(missing).be.empty();
  });

  it('should resolve a reference to its full commit identifier', async () => {
    // Arrange
    const repository = await tempRepository('gw-commit');

    // Act
    const actual = await gateway().resolveCommit(repository.root, 'HEAD');

    // Assert
    should(actual).equal(repository.head);
  });

  it('should refuse to resolve a reference that does not exist', async () => {
    // Arrange
    const repository = await tempRepository('gw-commit-bad');

    // Act
    const actual = await error(gateway().resolveCommit(repository.root, 'refs/heads/absent'));

    // Assert
    should((actual as Error).message).containEql('git commit resolution failed');
  });

  it('should refuse an identifier Git returns that is not a commit object id', async () => {
    // Arrange
    const repository = await tempRepository('gw-commit-garbage');
    const runner = new ScriptedGitRunner(invocation =>
      invocation.args.includes('--end-of-options') ? execution({ stdout: encode('not-an-oid\n') }) : undefined,
    );

    // Act
    const actual = await error(gateway(runner).resolveCommit(repository.root, 'HEAD'));

    // Assert
    should((actual as WorktreeAdapterError).code).equal('verification_failed');
    should((actual as WorktreeAdapterError).message).containEql('invalid commit identifier');
  });
});

describe('GitWorktreeGateway checkout safety', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  it('should accept a checkout with no content filters configured', async () => {
    // Arrange
    const repository = await tempRepository('gw-filters-clean');

    // Act
    const actual = await error(gateway().assertCheckoutFiltersSafe(repository.root));

    // Assert
    should(actual).be.undefined();
  });

  it('should refuse a checkout whose config would run a command on checkout', async () => {
    // Arrange — a repository-local smudge filter executes on every `worktree add`.
    const repository = await tempRepository('gw-filters-hostile');
    await setupGit(repository.root, 'config', '--local', 'filter.evil.smudge', 'touch pwned');

    // Act
    const actual = await error(gateway().assertCheckoutFiltersSafe(repository.root));

    // Assert
    should(actual).be.instanceof(WorktreeAdapterError);
    should((actual as WorktreeAdapterError).code).equal('unsafe_checkout_filter');
    should((actual as WorktreeAdapterError).message).containEql('filter.evil.smudge');
  });

  it('should raise a config failure that is not a plain "no match"', async () => {
    // Arrange
    const repository = await tempRepository('gw-filters-error');
    const runner = new ScriptedGitRunner(invocation =>
      invocation.args[0] === 'config' ? execution({ exitCode: 3, stderr: 'fatal: bad config' }) : undefined,
    );

    // Act
    const actual = await error(gateway(runner).assertCheckoutFiltersSafe(repository.root));

    // Assert
    should((actual as Error).message).equal('git filter inspection failed: fatal: bad config');
  });
});

describe('GitWorktreeGateway worktree lifecycle', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  it('should add a worktree on a new branch at an explicit commit', async () => {
    // Arrange
    const repository = await tempRepository('gw-add-new');
    const destination = path.join(await tempDirectory('gw-add-new-child'), 'wt');

    // Act
    await gateway().add(repository.root, destination, 'feature/new', repository.head, false, undefined, 30_000);

    // Assert
    const created = await gateway().inspect(destination);
    should(created.branch).equal('feature/new');
    should(created.head).equal(repository.head);
  });

  it('should add a worktree that checks out a branch which already exists', async () => {
    // Arrange
    const repository = await tempRepository('gw-add-existing');
    await setupGit(repository.root, 'branch', '--', 'feature/existing');
    const destination = path.join(await tempDirectory('gw-add-existing-child'), 'wt');

    // Act
    await gateway().add(repository.root, destination, 'feature/existing', repository.head, true, undefined, 30_000);

    // Assert
    should((await gateway().inspect(destination)).branch).equal('feature/existing');
  });

  it('should add a worktree tracking a remote branch', async () => {
    // Arrange
    const repository = await tempRepository('gw-add-tracking');
    await tempRemote(repository.root, 'origin', 'main');
    await setupGit(repository.root, 'fetch', '--quiet', 'origin');
    const destination = path.join(await tempDirectory('gw-add-tracking-child'), 'wt');

    // Act
    await gateway().add(
      repository.root,
      destination,
      'feature/tracked',
      repository.head,
      false,
      'refs/remotes/origin/main',
      30_000,
    );

    // Assert
    should(await gateway().pushState(destination, 'feature/tracked')).deepEqual({
      kind: 'pushed',
      upstream: 'refs/remotes/origin/main',
    });
  });

  it('should refuse to add a worktree where one already exists', async () => {
    // Arrange
    const repository = await tempRepository('gw-add-conflict');
    const destination = path.join(await tempDirectory('gw-add-conflict-child'), 'wt');
    await gateway().add(repository.root, destination, 'feature/first', repository.head, false, undefined, 30_000);

    // Act
    const actual = await error(
      gateway().add(repository.root, destination, 'feature/second', repository.head, false, undefined, 30_000),
    );

    // Assert
    should((actual as Error).message).containEql('git worktree add failed');
  });

  it('should remove a linked worktree through the shared Git directory', async () => {
    // Arrange
    const repository = await tempRepository('gw-remove');
    const linked = path.join(await tempDirectory('gw-remove-child'), 'wt');
    await setupGit(repository.root, 'worktree', 'add', '-b', 'feature/remove', '--', linked);
    const commonDir = path.join(repository.root, '.git');

    // Act
    await gateway().remove(commonDir, linked);

    // Assert
    should(await files.type(linked)).equal('missing');
    should(await gateway().list(repository.root)).have.length(1);
    should(await gateway().localBranchExists(repository.root, 'feature/remove')).be.true();
  });

  it('should refuse to remove a checkout Git considers unsafe to delete', async () => {
    // Arrange
    const repository = await tempRepository('gw-remove-dirty');
    const linked = path.join(await tempDirectory('gw-remove-dirty-child'), 'wt');
    await setupGit(repository.root, 'worktree', 'add', '-b', 'feature/dirty', '--', linked);
    await Bun.write(path.join(linked, 'README.md'), '# changed\n');

    // Act
    const actual = await error(gateway().remove(path.join(repository.root, '.git'), linked));

    // Assert
    should((actual as Error).message).containEql('git worktree remove failed');
    should(await files.type(linked)).equal('directory');
  });
});

describe('GitWorktreeGateway status and push state', () => {
  afterAll(async () => {
    await cleanupTempDirectories();
  });

  it('should report a pristine checkout as clean', async () => {
    // Arrange
    const repository = await tempRepository('gw-status-clean');

    // Act
    const actual = await gateway().status(repository.root);

    // Assert
    should(actual).deepEqual({
      staged: false,
      unstaged: false,
      untracked: false,
      ignored: false,
      conflicted: false,
      dirtySubmodule: false,
      truncated: false,
    });
  });

  it('should separate staged, unstaged, untracked, and ignored content', async () => {
    // Arrange
    const repository = await tempRepository('gw-status-dirty');
    await Bun.write(path.join(repository.root, '.gitignore'), 'ignored/\n');
    await setupGit(repository.root, 'add', '.gitignore');
    await setupGit(repository.root, 'commit', '--quiet', '-m', 'chore: ignore');
    await Bun.write(path.join(repository.root, 'staged.txt'), 'staged');
    await setupGit(repository.root, 'add', 'staged.txt');
    await Bun.write(path.join(repository.root, 'README.md'), '# edited\n');
    await Bun.write(path.join(repository.root, 'untracked.txt'), 'loose');
    await Bun.write(path.join(repository.root, 'ignored', 'secret.txt'), 'secret');

    // Act
    const actual = await gateway().status(repository.root);

    // Assert — each fact is independent, because each implies a different kind of data loss.
    should(actual.staged).be.true();
    should(actual.unstaged).be.true();
    should(actual.untracked).be.true();
    should(actual.ignored).be.true();
    should(actual.conflicted).be.false();
  });

  it('should report an unresolved merge as conflicted', async () => {
    // Arrange
    const repository = await tempRepository('gw-status-conflict');
    await setupGit(repository.root, 'checkout', '--quiet', '-b', 'other');
    await Bun.write(path.join(repository.root, 'README.md'), '# other\n');
    await setupGit(repository.root, 'commit', '--quiet', '-am', 'feat: other');
    await setupGit(repository.root, 'checkout', '--quiet', 'main');
    await Bun.write(path.join(repository.root, 'README.md'), '# main\n');
    await setupGit(repository.root, 'commit', '--quiet', '-am', 'feat: main');
    await setupGit(repository.root, 'merge', 'other').catch(() => undefined);

    // Act
    const actual = await gateway().status(repository.root);

    // Assert
    should(actual.conflicted).be.true();
  });

  it('should report a branch level with its upstream as pushed', async () => {
    // Arrange
    const repository = await tempRepository('gw-push-clean');
    await tempRemote(repository.root, 'origin', 'main');
    await setupGit(repository.root, 'branch', '--set-upstream-to', 'origin/main', 'main');

    // Act
    const actual = await gateway().pushState(repository.root, 'main');

    // Assert
    should(actual).deepEqual({ kind: 'pushed', upstream: 'refs/remotes/origin/main' });
  });

  it('should count how far a branch is ahead of its upstream', async () => {
    // Arrange
    const repository = await tempRepository('gw-push-ahead');
    await tempRemote(repository.root, 'origin', 'main');
    await setupGit(repository.root, 'branch', '--set-upstream-to', 'origin/main', 'main');
    await setupGit(repository.root, 'commit', '--quiet', '--allow-empty', '-m', 'feat: local only');

    // Act
    const actual = await gateway().pushState(repository.root, 'main');

    // Assert
    should(actual.kind).equal('unpushed');
    should(actual).have.property('reason', '1 commit ahead of refs/remotes/origin/main');
  });

  it('should pluralise the ahead count so the message is never wrong', async () => {
    // Arrange
    const repository = await tempRepository('gw-push-ahead-two');
    await tempRemote(repository.root, 'origin', 'main');
    await setupGit(repository.root, 'branch', '--set-upstream-to', 'origin/main', 'main');
    await setupGit(repository.root, 'commit', '--quiet', '--allow-empty', '-m', 'feat: one');
    await setupGit(repository.root, 'commit', '--quiet', '--allow-empty', '-m', 'feat: two');

    // Act
    const actual = await gateway().pushState(repository.root, 'main');

    // Assert
    should(actual).have.property('reason', '2 commits ahead of refs/remotes/origin/main');
  });

  it('should accept an untracked branch whose commit a remote already carries', async () => {
    // Arrange — no upstream is configured, but the work itself is not at risk.
    const repository = await tempRepository('gw-push-contained');
    await tempRemote(repository.root, 'origin', 'main');
    await setupGit(repository.root, 'fetch', '--quiet', 'origin');
    await setupGit(repository.root, 'branch', '--', 'feature/contained');

    // Act
    const actual = await gateway().pushState(repository.root, 'feature/contained');

    // Assert
    should(actual).deepEqual({ kind: 'pushed' });
  });

  it('should treat an untracked branch no remote carries as unpushed', async () => {
    // Arrange
    const repository = await tempRepository('gw-push-orphan');

    // Act
    const actual = await gateway().pushState(repository.root, 'main');

    // Assert
    should(actual.kind).equal('unpushed');
    should(actual).have.property('reason', 'HEAD is not contained in a fetched remote-tracking ref');
  });

  it('should refuse to guess when Git returns an ahead count it cannot parse', async () => {
    // Arrange
    const repository = await tempRepository('gw-push-garbage');
    await tempRemote(repository.root, 'origin', 'main');
    await setupGit(repository.root, 'branch', '--set-upstream-to', 'origin/main', 'main');
    const runner = new ScriptedGitRunner(invocation =>
      invocation.args[0] === 'rev-list' ? execution({ stdout: encode('lots\n') }) : undefined,
    );

    // Act
    const actual = await gateway(runner).pushState(repository.root, 'main');

    // Assert
    should(actual).deepEqual({ kind: 'unknown', reason: 'Git returned an invalid ahead count' });
  });
});
