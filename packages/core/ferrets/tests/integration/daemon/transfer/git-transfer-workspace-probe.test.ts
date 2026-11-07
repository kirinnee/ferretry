import { afterEach, describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';
import { BunGitRunner } from '../../../src/adapters/git/index.ts';
import { GitTransferWorkspaceProbe } from '../../../src/adapters/transfer/git-transfer-workspace-probe.ts';
import {
  GitWorktreeGateway,
  NodeWorktreeFileSystem,
  SystemWorktreeClock,
} from '../../../src/adapters/worktrees/index.ts';
import type { GitExecution, GitInvocation, GitRunner } from '../../../src/lib/worktrees/ports.ts';
import { cleanupTempDirectories, setupGit, tempDirectory, tempRepository } from '../support/repository.ts';

/**
 * Evidence about a real working tree, gathered against real Git.
 *
 * The probe's whole job is to answer without changing anything, so the interesting assertions are
 * about what it did NOT do: no worktree was added, no index was touched, and a repository that
 * cannot answer produces nulls rather than a refused transfer.
 */

const files = new NodeWorktreeFileSystem();
const clock = new SystemWorktreeClock();

const probe = (runner: GitRunner = new BunGitRunner()): GitTransferWorkspaceProbe =>
  new GitTransferWorkspaceProbe(new GitWorktreeGateway(runner, files, clock));

/** Records every Git invocation and otherwise lets real Git answer. */
class RecordingGitRunner implements GitRunner {
  readonly invocations: GitInvocation[] = [];

  constructor(private readonly reply: (invocation: GitInvocation) => GitExecution | undefined = () => undefined) {}

  async run(invocation: GitInvocation): Promise<GitExecution> {
    this.invocations.push(invocation);
    return this.reply(invocation) ?? (await new BunGitRunner().run(invocation));
  }
}

afterEach(async () => {
  await cleanupTempDirectories();
});

describe('GitTransferWorkspaceProbe', () => {
  it('should report the checkout it found and the dirt in it, without writing to the repository', async () => {
    // Arrange: an untracked file, so the status summary has something true to say.
    const repository = await tempRepository('transfer-workspace');
    await Bun.write(join(repository.root, 'scratch.txt'), 'work in progress\n');
    const runner = new RecordingGitRunner();
    const before = await setupGit(repository.root, 'status', '--porcelain');

    // Act
    const evidence = await probe(runner).probe(repository.root);

    // Assert
    should(evidence.head).equal(repository.head);
    should(evidence.status).eql({
      staged: false,
      unstaged: false,
      untracked: true,
      ignored: false,
      conflicted: false,
      dirtySubmodule: false,
      truncated: false,
    });
    // Every Git this probe ran is a question. `worktree list` reports checkouts; `worktree add` and
    // `worktree remove` create and destroy them, and neither is reachable from here.
    const asked = [
      ...new Set(
        runner.invocations.map(invocation =>
          invocation.args[0] === 'worktree' ? `worktree ${invocation.args[1]}` : (invocation.args[0] ?? ''),
        ),
      ),
    ].sort();
    should(asked).eql(['rev-parse', 'status', 'worktree list']);
    should(await setupGit(repository.root, 'status', '--porcelain')).equal(before);
  });

  it('should answer nulls for a directory that is not a repository, and for one that is not there', async () => {
    // Arrange: a cwd outside Git is ordinary, and a transfer must still be describable.
    const plain = await tempDirectory('transfer-workspace-plain');

    // Act
    const outside = await probe().probe(plain);
    const missing = await probe().probe(join(plain, 'deleted'));

    // Assert
    should(outside).eql({ head: null, status: null });
    should(missing).eql({ head: null, status: null });
  });

  it('should answer nulls rather than fail the transfer when Git itself cannot answer', async () => {
    // Arrange: inspection fails outright.
    const repository = await tempRepository('transfer-workspace-broken');
    const brokenInspect = new RecordingGitRunner(invocation =>
      invocation.args[0] === 'rev-parse'
        ? {
            exitCode: 128,
            stdout: new Uint8Array(),
            stderr: 'fatal: unable to read the repository',
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
          }
        : undefined,
    );

    // Act
    const evidence = await probe(brokenInspect).probe(repository.root);

    // Assert
    should(evidence).eql({ head: null, status: null });
  });

  it('should report a checkout whose dirtiness could not be summarised as head without status', async () => {
    // Arrange: inspection succeeds and only `git status` fails.
    const repository = await tempRepository('transfer-workspace-status');
    const brokenStatus = new RecordingGitRunner(invocation =>
      invocation.args[0] === 'status'
        ? {
            exitCode: 128,
            stdout: new Uint8Array(),
            stderr: 'fatal: could not read the index',
            stdoutTruncated: false,
            stderrTruncated: false,
            timedOut: false,
          }
        : undefined,
    );

    // Act
    const evidence = await probe(brokenStatus).probe(repository.root);

    // Assert: a partial answer is honest — the checkout was identified, its dirtiness was not.
    should(evidence.head).equal(repository.head);
    should(evidence.status).be.null();
  });
});
