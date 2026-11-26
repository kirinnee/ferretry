import { isListableCommonDirectory } from '../../../contract/index.ts';
import { WorktreeError } from '../../lib/worktrees/errors.ts';
import { parseWorktreeList } from '../../lib/worktrees/parser.ts';
import type { GitRunner } from '../../lib/worktrees/ports.ts';
import type { WorktreeListEntry } from '../../lib/worktrees/types.ts';
import { decodeGitOutput, stripFinalLineFeed } from '../git/result.ts';

/** `git worktree list` is a few hundred bytes a row; this holds thousands before it would call the output truncated. */
const LIST_OUTPUT_LIMIT = 8 * 1024 * 1024;

/**
 * The worktrees Git lists for a repository named by its common directory.
 *
 * THE REPOSITORY IS NAMED, NOT ENTERED. Every command takes `--git-dir=<common directory>` and runs in no folder, so a
 * repository no ferret stands in is still listable and nothing here reaches into a folder by name. The caller's path is
 * proven to be a COMMON directory by Git itself — its own git directory and its common directory are one and the same
 * (a linked worktree's git directory names a different common one, a worktree folder or a subfolder of .git is not a git
 * directory at all) — and anything else is refused in one sentence that echoes no Git output.
 */
export class GitRepoWorktreeRows {
  constructor(private readonly runner: GitRunner) {}

  async rows(commonDirectory: string): Promise<readonly WorktreeListEntry[]> {
    if (!isListableCommonDirectory(commonDirectory)) throw notACommonDirectory();
    const named = [`--git-dir=${commonDirectory}`];
    const proof = await this.runner.run({
      args: [...named, 'rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir'],
    });
    if (proof.timedOut) throw new WorktreeError('verification_failed', 'Git did not answer in time');
    const [gitDir, commonDir] = stripFinalLineFeed(decodeGitOutput(proof)).split('\n');
    if (proof.exitCode !== 0 || gitDir === undefined || gitDir === '' || gitDir !== commonDir)
      throw notACommonDirectory();

    const listing = await this.runner.run({
      args: [...named, 'worktree', 'list', '--porcelain', '-z'],
      maxStdoutBytes: LIST_OUTPUT_LIMIT,
    });
    if (listing.timedOut || listing.exitCode !== 0 || listing.stdoutTruncated) {
      throw new WorktreeError('verification_failed', 'Git could not list the worktrees of this repository');
    }
    return parseWorktreeList(decodeGitOutput(listing));
  }
}

const notACommonDirectory = (): WorktreeError =>
  new WorktreeError(
    'invalid_common_directory',
    'commonDir must be an absolute path to an existing git common directory',
  );
