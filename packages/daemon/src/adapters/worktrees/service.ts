import { createHash } from 'node:crypto';
import path from 'node:path';
import { assessWorktreeRemoval, hasDirtyWorktree, isPathInside } from '../../lib/worktrees/policy.ts';
import type { WorktreeFileSystem, WorktreeClock } from '../../lib/worktrees/ports.ts';
import type {
  CheckManagedWorktreeRemovalInput,
  CreatedManagedWorktree,
  CreateManagedWorktreeInput,
  GitCheckoutSnapshot,
  ManagedWorktreePlan,
  RemovedManagedWorktree,
  WorktreeRemovalDecision,
  WorktreeRemovalEvidence,
} from '../../lib/worktrees/types.ts';
import { WorktreeAdapterError } from './errors.ts';
import { GitWorktreeGateway } from './git-gateway.ts';
import { WorktreeOperationQueue } from './queue.ts';

const OWNERSHIP_MARKER = 'worktree-owner';

function stableHash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function pathSlug(value: string, maxLength: number): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
  return slug || 'repo';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertSafeInput(input: CreateManagedWorktreeInput): void {
  // Both refusals name what is actually wrong: a caller that cannot tell a bad session id from an
  // occupied destination cannot recover from either.
  if (!/^[a-zA-Z0-9._-]+$/.test(input.sessionId)) {
    throw new WorktreeAdapterError('invalid_session_id', 'session id is unsafe for a managed checkout path');
  }
  if (!/^[a-zA-Z0-9._-]{8,128}$/.test(input.ownershipToken)) {
    throw new WorktreeAdapterError('invalid_ownership_token', 'ownership token must be an opaque 8-128 character id');
  }
}

async function ensurePlainDirectory(fileSystem: WorktreeFileSystem, target: string): Promise<string> {
  const before = await fileSystem.type(target);
  if (before !== 'missing' && before !== 'directory') {
    throw new WorktreeAdapterError('destination_exists', `managed directory is not a plain directory: ${target}`);
  }
  await fileSystem.makeDirectory(target, 0o700);
  if ((await fileSystem.type(target)) !== 'directory') {
    throw new WorktreeAdapterError('destination_exists', `managed directory was replaced during creation: ${target}`);
  }
  const canonical = await fileSystem.realPath(target);
  if (canonical !== path.resolve(target)) {
    throw new WorktreeAdapterError('destination_exists', `managed directory resolves unexpectedly: ${target}`);
  }
  return canonical;
}

function branchConflict(branch: string, entries: readonly { readonly branch?: string; readonly path: string }[]) {
  return entries.find(entry => entry.branch === branch);
}

function requireSourceCheckout(
  snapshot: GitCheckoutSnapshot,
  sourceCwd: string,
): asserts snapshot is GitCheckoutSnapshot & {
  worktreeRoot: string;
  repositoryRoot: string;
  commonDir: string;
  head: string;
} {
  if (!snapshot.repo || !snapshot.worktreeRoot || !snapshot.repositoryRoot || !snapshot.commonDir || !snapshot.head) {
    throw new WorktreeAdapterError('not_git_repository', `${sourceCwd} is not a Git checkout with a commit`);
  }
}

async function resolveCreationPlan(
  gateway: GitWorktreeGateway,
  fileSystem: WorktreeFileSystem,
  source: GitCheckoutSnapshot & {
    worktreeRoot: string;
    repositoryRoot: string;
    commonDir: string;
    head: string;
  },
  input: CreateManagedWorktreeInput,
): Promise<ManagedWorktreePlan> {
  const branch = await gateway.validateBranch(input.sourceCwd, input.branch);
  const entries = await gateway.list(input.sourceCwd);
  const conflict = branchConflict(branch, entries);
  if (conflict !== undefined) {
    throw new WorktreeAdapterError(
      'branch_in_use',
      `branch ${JSON.stringify(branch)} is already checked out at ${conflict.path}`,
    );
  }

  const branchPreexisted = await gateway.localBranchExists(input.sourceCwd, branch);
  if (branchPreexisted && input.startPoint !== undefined) {
    throw new WorktreeAdapterError('invalid_branch', 'an existing branch cannot be combined with a start point');
  }

  let trackingRef: string | undefined;
  let startReference: string;
  if (branchPreexisted) {
    startReference = `refs/heads/${branch}`;
  } else if (input.startPoint?.trim()) {
    startReference = input.startPoint.trim();
  } else {
    const candidates = await gateway.remoteBranchCandidates(input.sourceCwd, branch);
    if (candidates.length > 1) {
      throw new WorktreeAdapterError(
        'ambiguous_remote_branch',
        `branch ${JSON.stringify(branch)} exists on multiple remotes: ${candidates.join(', ')}`,
      );
    }
    trackingRef = candidates[0];
    startReference = trackingRef ?? 'HEAD';
  }
  const startOid = await gateway.resolveCommit(input.sourceCwd, startReference);

  await fileSystem.makeDirectory(input.managedRoot, 0o700);
  const managedRoot = await fileSystem.realPath(input.managedRoot);
  const repoName = path.basename(source.repositoryRoot);
  const repoDirectory = path.join(managedRoot, `${pathSlug(repoName, 32)}-${stableHash(source.commonDir, 10)}`);
  await ensurePlainDirectory(fileSystem, repoDirectory);
  const destination = path.join(repoDirectory, `${pathSlug(branch, 48)}-${stableHash(branch, 8)}-${input.sessionId}`);
  if ((await fileSystem.type(destination)) !== 'missing') {
    throw new WorktreeAdapterError('destination_exists', `managed checkout destination exists: ${destination}`);
  }

  const sourceCwd = await fileSystem.realPath(input.sourceCwd);
  if (!isPathInside(source.worktreeRoot, sourceCwd)) {
    throw new WorktreeAdapterError('not_git_repository', 'source cwd is outside its detected checkout root');
  }
  const relativeCwd = path.relative(source.worktreeRoot, sourceCwd);
  return {
    sourceCwd,
    path: destination,
    sessionCwd: path.join(destination, relativeCwd),
    branch,
    repositoryRoot: source.repositoryRoot,
    commonDir: source.commonDir,
    ownershipToken: input.ownershipToken,
    branchPreexisted,
    startOid,
    trackingRef,
  };
}

function verifyCreatedCheckout(plan: ManagedWorktreePlan, checkout: GitCheckoutSnapshot): void {
  if (
    !checkout.repo ||
    checkout.kind !== 'linked_worktree' ||
    checkout.worktreeRoot !== plan.path ||
    checkout.repositoryRoot !== plan.repositoryRoot ||
    checkout.commonDir !== plan.commonDir ||
    checkout.branch !== plan.branch ||
    checkout.detached ||
    checkout.head !== plan.startOid ||
    checkout.gitDir === undefined
  ) {
    throw new WorktreeAdapterError(
      'verification_failed',
      `Git created ${plan.path}, but its repository, path, branch, or commit identity did not match the plan`,
    );
  }
}

export class ManagedWorktreeAdapter {
  constructor(
    private readonly gateway: GitWorktreeGateway,
    private readonly fileSystem: WorktreeFileSystem,
    private readonly clock: WorktreeClock,
    private readonly queue: WorktreeOperationQueue,
  ) {}

  async create(input: CreateManagedWorktreeInput): Promise<CreatedManagedWorktree> {
    assertSafeInput(input);
    const initial = await this.gateway.inspect(input.sourceCwd);
    requireSourceCheckout(initial, input.sourceCwd);

    return await this.queue.run(initial.commonDir, async () => {
      const source = await this.gateway.inspect(input.sourceCwd);
      requireSourceCheckout(source, input.sourceCwd);
      if (source.commonDir !== initial.commonDir) {
        throw new WorktreeAdapterError('verification_failed', 'source repository identity changed during creation');
      }
      await this.gateway.assertCheckoutFiltersSafe(input.sourceCwd);
      const plan = await resolveCreationPlan(this.gateway, this.fileSystem, source, input);
      await input.onPlanned?.(plan);
      await this.gateway.add(
        input.sourceCwd,
        plan.path,
        plan.branch,
        plan.startOid,
        plan.branchPreexisted,
        plan.trackingRef,
        input.timeoutMs ?? 30_000,
      );

      if ((await this.fileSystem.type(plan.sessionCwd)) !== 'directory') {
        throw new WorktreeAdapterError(
          'verification_failed',
          `Git created ${plan.path}, but the requested relative cwd is absent; the checkout was preserved`,
        );
      }
      const checkout = await this.gateway.inspect(plan.sessionCwd);
      verifyCreatedCheckout(plan, checkout);
      const gitDir = checkout.gitDir!;
      await this.fileSystem.writeText(path.join(gitDir, OWNERSHIP_MARKER), plan.ownershipToken, 0o600);
      const createdAt = this.clock.nowIso();
      return {
        cwd: plan.sessionCwd,
        checkout,
        managed: {
          version: 1,
          path: plan.path,
          branch: plan.branch,
          repositoryRoot: plan.repositoryRoot,
          commonDir: plan.commonDir,
          gitDir,
          ownershipToken: plan.ownershipToken,
          createdAt,
          initialHead: plan.startOid,
          branchPreexisted: plan.branchPreexisted,
        },
      };
    });
  }

  async checkRemoval(input: CheckManagedWorktreeRemovalInput): Promise<WorktreeRemovalDecision> {
    const gitErrors: string[] = [];
    let resolvedManagedRoot = path.resolve(input.managedRoot);
    try {
      resolvedManagedRoot = await this.fileSystem.realPath(input.managedRoot);
    } catch (error) {
      gitErrors.push(`managed root inspection failed: ${message(error)}`);
    }

    let resolvedPath: string | undefined;
    let checkout: GitCheckoutSnapshot | undefined;
    let status: WorktreeRemovalEvidence['status'];
    let pushState: WorktreeRemovalEvidence['pushState'];
    let ownershipMarkerMatches = false;
    if ((await this.fileSystem.type(input.managed.path)) !== 'missing') {
      try {
        resolvedPath = await this.fileSystem.realPath(input.managed.path);
      } catch (error) {
        gitErrors.push(`checkout path inspection failed: ${message(error)}`);
      }
      try {
        ownershipMarkerMatches =
          (await this.fileSystem.readText(path.join(input.managed.gitDir, OWNERSHIP_MARKER))) ===
          input.managed.ownershipToken;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          gitErrors.push(`ownership marker inspection failed: ${message(error)}`);
        }
      }
      if (resolvedPath !== undefined) {
        try {
          checkout = await this.gateway.inspect(resolvedPath);
        } catch (error) {
          gitErrors.push(`checkout inspection failed: ${message(error)}`);
        }
        if (checkout?.repo && checkout.branch !== undefined) {
          try {
            status = await this.gateway.status(resolvedPath);
          } catch (error) {
            gitErrors.push(`checkout status failed: ${message(error)}`);
          }
          try {
            pushState = await this.gateway.pushState(resolvedPath, checkout.branch);
          } catch (error) {
            pushState = { kind: 'unknown', reason: `push-state inspection failed: ${message(error)}` };
          }
        }
      }
    }

    return assessWorktreeRemoval({
      recordedPath: input.managed.path,
      managedRoot: input.managedRoot,
      resolvedManagedRoot,
      resolvedPath,
      expectedRepositoryRoot: input.managed.repositoryRoot,
      expectedCommonDir: input.managed.commonDir,
      expectedGitDir: input.managed.gitDir,
      expectedBranch: input.managed.branch,
      ownershipMarkerMatches,
      ownerActive: input.ownerActive,
      currentWorkingDirectory: input.currentWorkingDirectory,
      otherSessions: input.otherSessions ?? [],
      liveTerminals: input.liveTerminals ?? 0,
      checkout,
      status,
      pushState,
      gitErrors,
    });
  }

  async remove(input: CheckManagedWorktreeRemovalInput): Promise<RemovedManagedWorktree> {
    return await this.queue.run(input.managed.commonDir, async () => {
      const decision = await this.checkRemoval(input);
      if (!decision.removable) {
        throw new WorktreeAdapterError(
          'unsafe_remove',
          `refusing to remove ${decision.path}: ${decision.blockers.map(item => item.message).join('; ')}`,
          decision.blockers,
        );
      }
      const finalStatus = await this.gateway.status(decision.path);
      if (hasDirtyWorktree(finalStatus)) {
        const raced = await this.checkRemoval(input);
        throw new WorktreeAdapterError(
          'unsafe_remove',
          `refusing to remove ${decision.path}: checkout content changed after preflight`,
          raced.blockers,
        );
      }
      await this.gateway.remove(input.managed.commonDir, decision.path);
      return {
        path: decision.path,
        branch: input.managed.branch,
        branchRetained: true,
        removedAt: this.clock.nowIso(),
      };
    });
  }
}
