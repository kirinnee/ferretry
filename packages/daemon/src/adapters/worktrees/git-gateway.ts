import path from 'node:path';
import type { GitRunner, WorktreeClock, WorktreeFileSystem } from '../../lib/worktrees/ports.ts';
import { parseWorktreeList, parseWorktreeStatus } from '../../lib/worktrees/parser.ts';
import type {
  GitCheckoutSnapshot,
  WorktreeListEntry,
  WorktreePushState,
  WorktreeStatusSummary,
} from '../../lib/worktrees/types.ts';
import { decodeGitOutput, requireGitExit, stripFinalLineFeed } from '../git/result.ts';
import { WorktreeAdapterError } from './errors.ts';

async function runGit(
  runner: GitRunner,
  cwd: string,
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
    const execution = await runGit(
      this.runner,
      cwd,
      ['worktree', 'list', '--porcelain', '-z'],
      'git worktree list',
    );
    if (execution.stdoutTruncated) {
      throw new WorktreeAdapterError('verification_failed', 'git worktree list output was truncated');
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
      throw new WorktreeAdapterError('verification_failed', 'Git did not list the current checkout');
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
      throw new WorktreeAdapterError('invalid_branch', `invalid branch ${JSON.stringify(requested)}`);
    }
    const execution = await this.runner.run({ cwd, args: ['check-ref-format', '--branch', branch] });
    if (execution.timedOut || execution.exitCode !== 0) {
      throw new WorktreeAdapterError(
        'invalid_branch',
        `invalid branch ${JSON.stringify(requested)}: ${execution.stderr.trim() || `exit ${execution.exitCode}`}`,
      );
    }
    const normalized = stripFinalLineFeed(decodeGitOutput(execution));
    if (normalized !== branch) {
      throw new WorktreeAdapterError('invalid_branch', `branch ${JSON.stringify(requested)} is not literal`);
    }
    return branch;
  }

  async localBranchExists(cwd: string, branch: string): Promise<boolean> {
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
      throw new WorktreeAdapterError('verification_failed', 'Git returned an invalid commit identifier');
    }
    return oid;
  }

  async assertCheckoutFiltersSafe(cwd: string): Promise<void> {
    const execution = await this.runner.run({
      cwd,
      args: [
        'config',
        '--local',
        '--no-includes',
        '--name-only',
        '--get-regexp',
        '^filter\\..*\\.(smudge|process)$',
      ],
    });
    if (!execution.timedOut && execution.exitCode === 1) return;
    requireGitExit('git filter inspection', execution);
    const names = decodeGitOutput(execution)
      .split('\n')
      .filter(value => value.length > 0);
    if (names.length > 0) {
      throw new WorktreeAdapterError(
        'unsafe_checkout_filter',
        `refusing a checkout that could execute configured filters: ${names.join(', ')}`,
      );
    }
  }

  async add(
    cwd: string,
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
      [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--ignored=matching',
        '--ignore-submodules=none',
      ],
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

  async remove(commonDir: string, target: string): Promise<void> {
    await runGit(
      this.runner,
      path.dirname(commonDir),
      [`--git-dir=${commonDir}`, 'worktree', 'remove', '--', target],
      'git worktree remove',
      [0],
      { timeoutMs: 120_000 },
    );
  }
}
