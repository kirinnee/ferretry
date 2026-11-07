import type { GitRunner, GitWorkingDirectory, WorktreeClock, WorktreeFileSystem } from '../../lib/worktrees/ports.ts';
import { parseWorktreeList, parseWorktreeStatus } from '../../lib/worktrees/parser.ts';
import type {
  GitCheckoutSnapshot,
  WorktreeDivergence,
  WorktreeListEntry,
  WorktreePushState,
  WorktreeStatusSummary,
} from '../../lib/worktrees/types.ts';
import { decodeGitOutput, requireGitExit, stripFinalLineFeed } from '../git/result.ts';
import { WorktreeError } from '../../lib/worktrees/errors.ts';

async function runGit(
  runner: GitRunner,
  cwd: GitWorkingDirectory,
  args: readonly string[],
  action: string,
  acceptedExitCodes: readonly number[] = [0],
  options: { readonly timeoutMs?: number; readonly maxStdoutBytes?: number } = {},
) {
  const execution = await runner.run({ cwd, args, ...options });
  return requireGitExit(action, execution, acceptedExitCodes);
}

async function canonicalRecord(
  fileSystem: WorktreeFileSystem,
  records: readonly WorktreeListEntry[],
  checkoutRoot: string,
): Promise<WorktreeListEntry | undefined> {
  const expected = await fileSystem.realPath(checkoutRoot);
  for (const record of records) {
    try {
      if ((await fileSystem.realPath(record.path)) === expected) return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

export class GitWorktreeGateway {
  constructor(
    private readonly runner: GitRunner,
    private readonly fileSystem: WorktreeFileSystem,
    private readonly clock: WorktreeClock,
  ) {}

  async list(cwd: string): Promise<readonly WorktreeListEntry[]> {
    const execution = await runGit(this.runner, cwd, ['worktree', 'list', '--porcelain', '-z'], 'git worktree list');
    if (execution.stdoutTruncated) {
      throw new WorktreeError('verification_failed', 'git worktree list output was truncated');
    }
    return parseWorktreeList(decodeGitOutput(execution));
  }

  async inspect(cwd: string): Promise<GitCheckoutSnapshot> {
    const observedAt = this.clock.nowIso();
    if ((await this.fileSystem.type(cwd)) === 'missing') return { repo: false, kind: 'missing', observedAt };
    const canonicalCwd = await this.fileSystem.realPath(cwd);
    const inside = await this.runner.run({ cwd: canonicalCwd, args: ['rev-parse', '--is-inside-work-tree'] });
    if (inside.exitCode !== 0) {
      if (!inside.timedOut && inside.stderr.includes('not a git repository')) {
        return { repo: false, kind: 'not_git', observedAt };
      }
      requireGitExit('git rev-parse', inside);
    }
    if (stripFinalLineFeed(decodeGitOutput(inside)) !== 'true') {
      return { repo: false, kind: 'not_git', observedAt };
    }

    const [rootResult, gitDirResult, commonDirResult] = await Promise.all([
      runGit(
        this.runner,
        canonicalCwd,
        ['rev-parse', '--path-format=absolute', '--show-toplevel'],
        'git repository root',
      ),
      runGit(this.runner, canonicalCwd, ['rev-parse', '--absolute-git-dir'], 'git directory'),
      runGit(
        this.runner,
        canonicalCwd,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        'git common directory',
      ),
    ]);
    const worktreeRoot = await this.fileSystem.realPath(stripFinalLineFeed(decodeGitOutput(rootResult)));
    const gitDir = await this.fileSystem.realPath(stripFinalLineFeed(decodeGitOutput(gitDirResult)));
    const commonDir = await this.fileSystem.realPath(stripFinalLineFeed(decodeGitOutput(commonDirResult)));
    const records = await this.list(canonicalCwd);
    const current = await canonicalRecord(this.fileSystem, records, worktreeRoot);
    if (current === undefined) {
      throw new WorktreeError('verification_failed', 'Git did not list the current checkout');
    }
    const main = records[0];
    const repositoryRoot = main === undefined ? worktreeRoot : await this.fileSystem.realPath(main.path);
    return {
      repo: true,
      kind: gitDir === commonDir ? 'main_checkout' : 'linked_worktree',
      worktreeRoot,
      repositoryRoot,
      gitDir,
      commonDir,
      branch: current.branch,
      detached: current.detached || current.branch === undefined,
      head: current.head,
      locked: current.locked,
      prunable: current.prunable,
      observedAt,
    };
  }

  async validateBranch(cwd: string, requested: string): Promise<string> {
    const branch = requested.trim();
    if (branch.length === 0 || branch.startsWith('-') || branch.includes('\0')) {
      throw new WorktreeError('invalid_branch', `invalid branch ${JSON.stringify(requested)}`);
    }
    const execution = await this.runner.run({ cwd, args: ['check-ref-format', '--branch', branch] });
    if (execution.timedOut || execution.exitCode !== 0) {
      throw new WorktreeError(
        'invalid_branch',
        `invalid branch ${JSON.stringify(requested)}: ${execution.stderr.trim() || `exit ${execution.exitCode}`}`,
      );
    }
    const normalized = stripFinalLineFeed(decodeGitOutput(execution));
    if (normalized !== branch) {
      throw new WorktreeError('invalid_branch', `branch ${JSON.stringify(requested)} is not literal`);
    }
    return branch;
  }

  async localBranchExists(cwd: GitWorkingDirectory, branch: string): Promise<boolean> {
    const execution = await this.runner.run({
      cwd,
      args: ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    });
    if (!execution.timedOut && execution.exitCode === 1) return false;
    requireGitExit('git show-ref', execution);
    return true;
  }

  async remoteBranchCandidates(cwd: string, branch: string): Promise<readonly string[]> {
    const execution = await runGit(
      this.runner,
      cwd,
      ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
      'git remote branch list',
    );
    return decodeGitOutput(execution)
      .split('\n')
      .map(ref => ref.trim())
      .filter(ref => ref.length > 0 && !ref.endsWith('/HEAD'))
      .filter(ref => ref.replace(/^refs\/remotes\/[^/]+\//, '') === branch);
  }

  async resolveCommit(cwd: string, reference: string): Promise<string> {
    const execution = await runGit(
      this.runner,
      cwd,
      ['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`],
      'git commit resolution',
    );
    const oid = stripFinalLineFeed(decodeGitOutput(execution));
    if (!/^[0-9a-fA-F]{40,64}$/.test(oid)) {
      throw new WorktreeError('verification_failed', 'Git returned an invalid commit identifier');
    }
    return oid;
  }

  /**
   * Refuses a checkout that could run a configured filter during `worktree add`.
   *
   * IT MUST READ THE CONFIGURATION THE MUTATION WILL HONOUR, not a narrower one. This used to ask
   * `--local --no-includes`, and both halves of that were wrong: `include.path` and `includeIf`
   * directives are followed by the checkout, and a per-worktree `config.worktree` is another file
   * `--local` never opens. A filter reached through either would have executed with the daemon's
   * privileges while this gate reported the repository clean — a gate that reads a different file
   * than the operation it guards is not a gate.
   *
   * The listing is the full effective set precisely because the runner has already neutralized what
   * this must not consider: `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` mean "every
   * scope" is exactly the repository's own configuration and whatever it includes.
   */
  async assertCheckoutFiltersSafe(cwd: GitWorkingDirectory): Promise<void> {
    const execution = await this.runner.run({
      cwd,
      args: ['config', '--list', '--includes', '--name-only', '-z'],
    });
    if (!execution.timedOut && execution.exitCode === 1) return;
    requireGitExit('git filter inspection', execution);
    const names = decodeGitOutput(execution)
      .split('\0')
      .filter(value => /^filter\..*\.(smudge|process)$/u.test(value));
    if (names.length > 0) {
      throw new WorktreeError(
        'unsafe_checkout_filter',
        `refusing a checkout that could execute configured filters: ${names.join(', ')}`,
      );
    }
  }

  async add(
    cwd: GitWorkingDirectory,
    destination: string,
    branch: string,
    startOid: string,
    branchPreexisted: boolean,
    trackingRef: string | undefined,
    timeoutMs: number,
  ): Promise<void> {
    const args = branchPreexisted
      ? ['worktree', 'add', '--', destination, branch]
      : trackingRef === undefined
        ? ['worktree', 'add', '-b', branch, '--', destination, startOid]
        : ['worktree', 'add', '--track', '-b', branch, '--', destination, trackingRef];
    await runGit(this.runner, cwd, args, 'git worktree add', [0], { timeoutMs });
  }

  async status(cwd: string): Promise<WorktreeStatusSummary> {
    const execution = await runGit(
      this.runner,
      cwd,
      ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'],
      'git status',
    );
    return parseWorktreeStatus(decodeGitOutput(execution), execution.stdoutTruncated);
  }

  async pushState(cwd: string, branch: string): Promise<WorktreePushState> {
    const upstreamResult = await runGit(
      this.runner,
      cwd,
      ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`],
      'git branch upstream',
    );
    const upstream = stripFinalLineFeed(decodeGitOutput(upstreamResult));
    if (upstream.startsWith('refs/remotes/')) {
      const aheadResult = await runGit(
        this.runner,
        cwd,
        ['rev-list', '--count', `${upstream}..HEAD`],
        'git ahead count',
      );
      const count = Number(stripFinalLineFeed(decodeGitOutput(aheadResult)));
      if (!Number.isSafeInteger(count) || count < 0) {
        return { kind: 'unknown', reason: 'Git returned an invalid ahead count' };
      }
      return count === 0
        ? { kind: 'pushed', upstream }
        : {
            kind: 'unpushed',
            upstream,
            reason: `${count} commit${count === 1 ? '' : 's'} ahead of ${upstream}`,
          };
    }

    const containingResult = await runGit(
      this.runner,
      cwd,
      ['for-each-ref', '--contains=HEAD', '--format=%(refname)', 'refs/remotes'],
      'git remote containment',
    );
    const containing = decodeGitOutput(containingResult)
      .split('\n')
      .filter(ref => ref.trim().length > 0);
    return containing.length > 0
      ? { kind: 'pushed' }
      : { kind: 'unpushed', reason: 'HEAD is not contained in a fetched remote-tracking ref' };
  }

  /**
   * How far the branch has diverged from its upstream, or nothing when Git would not say.
   *
   * `--left-right --count A...B` prints the two counts Git itself computed, so "behind" is not
   * derived from "ahead" by arithmetic this side could get backwards. An answer that is not two
   * safe non-negative integers is NO answer: reporting a zero the repository did not state would
   * make a diverged branch read as up to date.
   */
  async divergence(cwd: string, upstream: string): Promise<WorktreeDivergence | undefined> {
    const execution = await this.runner.run({
      cwd,
      args: ['rev-list', '--left-right', '--count', '--end-of-options', `${upstream}...HEAD`],
    });
    if (execution.timedOut || execution.exitCode !== 0) return undefined;
    const counts = stripFinalLineFeed(decodeGitOutput(execution)).split(/\s+/u).map(Number);
    const [behind, ahead] = counts;
    if (counts.length !== 2 || behind === undefined || ahead === undefined) return undefined;
    if (!Number.isSafeInteger(behind) || !Number.isSafeInteger(ahead) || behind < 0 || ahead < 0) return undefined;
    return { ahead, behind };
  }

  /**
   * The repository's default branch as LOCAL data knows it, or nothing.
   *
   * `refs/remotes/origin/HEAD` is a local symbolic ref; reading it fetches nothing and contacts
   * nobody. A repository that never had it set — a fresh `git init`, or a clone made with
   * `--no-checkout` — has no default branch this side may invent, and says so.
   */
  async defaultBranch(cwd: string): Promise<string | undefined> {
    const execution = await this.runner.run({
      cwd,
      args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    });
    if (execution.timedOut || execution.exitCode !== 0) return undefined;
    const reference = stripFinalLineFeed(decodeGitOutput(execution));
    return reference.length === 0 ? undefined : reference;
  }

  /**
   * Whether the branch is already contained in its integration target.
   *
   * THREE ANSWERS, NOT TWO. Yes, no, and "Git could not tell me" — and the third is why this returns
   * an optional rather than a boolean. A missing target read as "integrated" would delete unmerged
   * work; read as "not integrated" it merely demands an explicit confirmation, which is the
   * direction a caller can recover from.
   */
  async isIntegrated(cwd: string, branch: string, target: string): Promise<boolean | undefined> {
    const execution = await this.runner.run({
      cwd,
      args: ['merge-base', '--is-ancestor', '--end-of-options', `refs/heads/${branch}`, target],
    });
    if (execution.timedOut) return undefined;
    if (execution.exitCode === 0) return true;
    return execution.exitCode === 1 ? false : undefined;
  }

  /**
   * Deletes a branch through the repository's own Git directory.
   *
   * `force` is `git branch -D`, and it is reached only after the branch-deletion policy has already
   * accepted an explicit confirmation for every reason deletion would lose work. Git's own `-d`
   * refusal is a second opinion this side keeps rather than routes around.
   */
  async deleteBranch(cwd: GitWorkingDirectory, branch: string, force: boolean): Promise<void> {
    await runGit(this.runner, cwd, ['branch', force ? '-D' : '-d', '--', branch], 'git branch delete');
  }

  /**
   * Removes the checkout.
   *
   * `force` is Git's own, and it is NOT a blanket force: the caller reaches it only by having
   * consented to the exact class of loss — uncommitted content — that makes Git refuse, and every
   * other blocker has already been decided separately. Without it a consented
   * `discard_worktree_changes` would be accepted by the daemon and then refused by Git, which is a
   * removal that says yes and does nothing.
   */
  async remove(cwd: GitWorkingDirectory, force = false): Promise<void> {
    await runGit(
      this.runner,
      cwd,
      ['worktree', 'remove', ...(force ? ['--force'] : []), '--', '.'],
      'git worktree remove',
      [0],
      { timeoutMs: 120_000 },
    );
  }
}
