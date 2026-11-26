import { isListableCommonDirectory } from '../../../contract/index.ts';
import { WorktreeError } from '../../lib/worktrees/errors.ts';
import { parseWorktreeList } from '../../lib/worktrees/parser.ts';
import type { GitRunner } from '../../lib/worktrees/ports.ts';
import type { WorktreeListEntry } from '../../lib/worktrees/types.ts';
import { decodeGitOutput, stripFinalLineFeed } from '../git/result.ts';
import type { RepoDirectoryPin, RepoWorktreeAccess } from './repo-access.ts';

/** `git worktree list` is a few hundred bytes a row; this holds thousands before it would call the output truncated. */
const LIST_OUTPUT_LIMIT = 8 * 1024 * 1024;

/**
 * The worktrees Git lists for a repository named by its common directory.
 *
 * The host authorizes and pins the common directory before Git reads it. Git runs inside that held object with
 * `--git-dir=.`; its absolute git directory and common directory must both equal the authorized directory. Each row
 * must independently prove its checkout and metadata still belong to that same held repository before any Git read.
 */
export class GitRepoWorktreeRows {
  private repository: RepoDirectoryPin | undefined;
  constructor(
    private readonly runner: GitRunner,
    private readonly access: RepoWorktreeAccess,
  ) {}

  async rows(commonDirectory: string, signal?: AbortSignal): Promise<readonly WorktreeListEntry[]> {
    if (!isListableCommonDirectory(commonDirectory)) throw notACommonDirectory();
    signal?.throwIfAborted();
    const repository = await this.access.repository(commonDirectory);
    if (signal?.aborted === true) {
      await repository.close();
      signal.throwIfAborted();
    }
    try {
      const entries = await this.#read(repository, signal);
      signal?.throwIfAborted();
      this.repository = repository;
      return entries;
    } catch (error) {
      await repository.close();
      throw error;
    }
  }

  async #read(repository: RepoDirectoryPin, signal?: AbortSignal): Promise<readonly WorktreeListEntry[]> {
    const named = ['--git-dir=.'];
    await repository.verify();
    const proof = await this.runner.run({
      cwd: repository.cwd,
      signal,
      args: [...named, 'rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'],
    });
    if (proof.timedOut) throw new WorktreeError('verification_failed', 'Git did not answer in time');
    const [gitDir, commonDir] = stripFinalLineFeed(decodeGitOutput(proof)).split('\n');
    if (proof.exitCode !== 0 || proof.stdoutTruncated || gitDir !== repository.rootReal || gitDir !== commonDir)
      throw notACommonDirectory();

    signal?.throwIfAborted();
    await repository.verify();
    const listing = await this.runner.run({
      cwd: repository.cwd,
      signal,
      args: [...named, 'worktree', 'list', '--porcelain', '-z'],
      maxStdoutBytes: LIST_OUTPUT_LIMIT,
    });
    await repository.verify();
    if (listing.timedOut || listing.exitCode !== 0 || listing.stdoutTruncated) {
      throw new WorktreeError('verification_failed', 'Git could not list the worktrees of this repository');
    }
    return parseWorktreeList(decodeGitOutput(listing));
  }

  /** Every read uses the held checkout, after proving its metadata belongs to the held common directory. */
  async inCheckout<T>(
    folder: string,
    signal: AbortSignal | undefined,
    read: (runner: GitRunner) => Promise<T>,
  ): Promise<T> {
    const repository = this.repository;
    if (repository === undefined) throw notACommonDirectory();
    signal?.throwIfAborted();
    const checkout = await this.access.checkout(folder, repository);
    try {
      signal?.throwIfAborted();
      return await read({
        run: async invocation => {
          signal?.throwIfAborted();
          await checkout.verify();
          signal?.throwIfAborted();
          const result = await this.runner.run({
            ...invocation,
            cwd: checkout.cwd,
            signal,
            args: [`--git-dir=${checkout.gitDirectory}`, ...invocation.args],
          });
          signal?.throwIfAborted();
          await checkout.verify();
          return result;
        },
      });
    } finally {
      await checkout.close();
    }
  }

  async close(): Promise<void> {
    await this.repository?.close();
    this.repository = undefined;
  }
}

const notACommonDirectory = (): WorktreeError =>
  new WorktreeError(
    'invalid_common_directory',
    'commonDir must be an absolute path to an existing git common directory',
  );
