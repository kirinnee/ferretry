import { createHash } from 'node:crypto';
import path from 'node:path';
import { unclearedRemovalBlockers, type WorktreeLiveState } from '@ferretry/protocol';
import { WorktreeError, WorktreeRemovalRefusal } from '../../lib/worktrees/errors.ts';
import { assessBranchDeletion, assessWorktreeRemoval, isWithinDirectory } from '../../lib/worktrees/policy.ts';
import type {
  GitWorkingDirectory,
  WorktreeClock,
  WorktreeDirectoryPinner,
  WorktreeFileSystem,
} from '../../lib/worktrees/ports.ts';
import type {
  BranchDeletionEvidence,
  CheckManagedWorktreeRemovalInput,
  CreatedManagedWorktree,
  CreateManagedWorktreeInput,
  GitCheckoutSnapshot,
  ManagedWorktree,
  ManagedWorktreeAdoption,
  ManagedWorktreeInspection,
  ManagedWorktreeIntent,
  ManagedWorktreePlan,
  ManagedWorktreePresence,
  RemovedManagedWorktree,
  RemoveManagedWorktreeInput,
  WorktreeListEntry,
  WorktreeRemovalBlocker,
  WorktreeRemovalEvidence,
} from '../../lib/worktrees/types.ts';
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
    throw new WorktreeError('invalid_session_id', 'session id is unsafe for a managed checkout path');
  }
  if (!/^[a-zA-Z0-9._-]{8,128}$/.test(input.ownershipToken)) {
    throw new WorktreeError('invalid_ownership_token', 'ownership token must be an opaque 8-128 character id');
  }
}

async function ensurePlainDirectory(fileSystem: WorktreeFileSystem, target: string): Promise<string> {
  const before = await fileSystem.type(target);
  if (before !== 'missing' && before !== 'directory') {
    throw new WorktreeError('destination_exists', `managed directory is not a plain directory: ${target}`);
  }
  await fileSystem.makeDirectory(target, 0o700);
  if ((await fileSystem.type(target)) !== 'directory') {
    throw new WorktreeError('destination_exists', `managed directory was replaced during creation: ${target}`);
  }
  const canonical = await fileSystem.realPath(target);
  if (canonical !== path.resolve(target)) {
    throw new WorktreeError('destination_exists', `managed directory resolves unexpectedly: ${target}`);
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
    throw new WorktreeError('not_git_repository', `${sourceCwd} is not a Git checkout with a commit`);
  }
}

/**
 * Where a new branch starts, and whether it should track anything.
 *
 * `auto` is the caller who named only a branch: exactly one remote carrying that name is tracked,
 * and anything else forks the source checkout's own commit. The explicit bases never track — forking
 * FROM the default branch must not leave the new branch pushing back TO it, which is what setting an
 * upstream would mean.
 */
async function resolveStartReference(
  gateway: GitWorktreeGateway,
  input: CreateManagedWorktreeInput,
  branch: string,
  branchPreexisted: boolean,
): Promise<{ readonly startReference: string; readonly trackingRef?: string }> {
  const base = input.base ?? { kind: 'auto' };
  if (branchPreexisted) {
    if (base.kind !== 'auto') {
      throw new WorktreeError('invalid_branch', 'an existing branch cannot be combined with a start point');
    }
    return { startReference: `refs/heads/${branch}` };
  }
  if (base.kind === 'head') return { startReference: 'HEAD' };
  if (base.kind === 'commit') {
    const reference = base.reference.trim();
    if (reference.length === 0) throw new WorktreeError('unresolved_base', 'the requested base is empty');
    return { startReference: reference };
  }
  if (base.kind === 'default-branch') {
    const target = await gateway.defaultBranch(input.sourceCwd);
    if (target === undefined) {
      throw new WorktreeError(
        'unresolved_base',
        'this repository records no origin/HEAD, so its default branch cannot be resolved from local data',
      );
    }
    return { startReference: target };
  }
  const candidates = await gateway.remoteBranchCandidates(input.sourceCwd, branch);
  if (candidates.length > 1) {
    throw new WorktreeError(
      'ambiguous_remote_branch',
      `branch ${JSON.stringify(branch)} exists on multiple remotes: ${candidates.join(', ')}`,
    );
  }
  const trackingRef = candidates[0];
  return trackingRef === undefined ? { startReference: 'HEAD' } : { startReference: trackingRef, trackingRef };
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
    throw new WorktreeError(
      'branch_in_use',
      `branch ${JSON.stringify(branch)} is already checked out at ${conflict.path}`,
    );
  }

  const branchPreexisted = await gateway.localBranchExists(input.sourceCwd, branch);
  const { startReference, trackingRef } = await resolveStartReference(gateway, input, branch, branchPreexisted);
  const startOid = await gateway.resolveCommit(input.sourceCwd, startReference);

  await fileSystem.makeDirectory(input.managedRoot, 0o700);
  const managedRoot = await fileSystem.realPath(input.managedRoot);
  const repoName = path.basename(source.repositoryRoot);
  const repoDirectory = path.join(managedRoot, `${pathSlug(repoName, 32)}-${stableHash(source.commonDir, 10)}`);
  await ensurePlainDirectory(fileSystem, repoDirectory);
  const destination = path.join(repoDirectory, `${pathSlug(branch, 48)}-${stableHash(branch, 8)}-${input.sessionId}`);
  if ((await fileSystem.type(destination)) !== 'missing') {
    throw new WorktreeError('destination_exists', `managed checkout destination exists: ${destination}`);
  }

  const sourceCwd = await fileSystem.realPath(input.sourceCwd);
  if (!isWithinDirectory(source.worktreeRoot, sourceCwd)) {
    throw new WorktreeError('not_git_repository', 'source cwd is outside its detected checkout root');
  }
  const relativeCwd = path.relative(source.worktreeRoot, sourceCwd);
  return {
    sourceCwd,
    path: destination,
    sessionCwd: path.join(destination, relativeCwd),
    relativeCwd,
    branch,
    repositoryRoot: source.repositoryRoot,
    commonDir: source.commonDir,
    ownershipToken: input.ownershipToken,
    branchPreexisted,
    startOid,
    ...(trackingRef === undefined ? {} : { trackingRef }),
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
    throw new WorktreeError(
      'verification_failed',
      `Git created ${plan.path}, but its repository, path, branch, or commit identity did not match the plan`,
    );
  }
}

/** The branch a remote-tracking name carries: `origin/main` names the branch `main`. */
function branchOfTrackingName(reference: string | undefined): string | undefined {
  if (reference === undefined) return undefined;
  const separator = reference.indexOf('/');
  return separator < 0 ? reference : reference.slice(separator + 1);
}

/** Whether any checkout OTHER than this one holds the branch. */
function checkedOutElsewhere(entries: readonly WorktreeListEntry[], branch: string, target: string): boolean {
  return entries.some(entry => entry.branch === branch && path.resolve(entry.path) !== path.resolve(target));
}

/** A stable fingerprint of a verdict, so "the same blockers as a moment ago" is a comparison. */
function blockerFingerprint(blockers: readonly WorktreeRemovalBlocker[]): string {
  return [...blockers.map(blocker => `${blocker.code}:${blocker.message}`)].sort().join('\n');
}

function describe(blockers: readonly WorktreeRemovalBlocker[]): string {
  return blockers.map(blocker => `${blocker.code}: ${blocker.message}`).join('; ');
}

export class ManagedWorktreeAdapter {
  constructor(
    private readonly gateway: GitWorktreeGateway,
    private readonly fileSystem: WorktreeFileSystem,
    private readonly clock: WorktreeClock,
    private readonly queue: WorktreeOperationQueue,
    private readonly pinner: WorktreeDirectoryPinner,
  ) {}

  async create(input: CreateManagedWorktreeInput): Promise<CreatedManagedWorktree> {
    assertSafeInput(input);
    const initial = await this.gateway.inspect(input.sourceCwd);
    requireSourceCheckout(initial, input.sourceCwd);

    return await this.queue.run(initial.commonDir, async () => {
      const source = await this.gateway.inspect(input.sourceCwd);
      requireSourceCheckout(source, input.sourceCwd);
      if (source.commonDir !== initial.commonDir) {
        throw new WorktreeError('verification_failed', 'source repository identity changed during creation');
      }
      const plan = await resolveCreationPlan(this.gateway, this.fileSystem, source, input);
      await input.onPlanned?.(plan);
      await this.#withPinned(
        plan.sourceCwd,
        () => new WorktreeError('verification_failed', 'source checkout identity changed before worktree creation'),
        async pinnedCwd => {
          // The safety read and the mutation use the SAME held checkout. Reading filters by name and
          // then spawning against a pin (or the reverse) would still authorize one repository and
          // mutate another.
          await this.gateway.assertCheckoutFiltersSafe(pinnedCwd);
          await this.gateway.add(
            pinnedCwd,
            plan.path,
            plan.branch,
            plan.startOid,
            plan.branchPreexisted,
            plan.trackingRef,
            input.timeoutMs ?? 30_000,
          );
        },
      );

      if ((await this.fileSystem.type(plan.sessionCwd)) !== 'directory') {
        throw new WorktreeError(
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
          sourceCwd: plan.sourceCwd,
          relativeCwd: plan.relativeCwd,
          ...(input.ownerSessionId === undefined ? {} : { ownerSessionId: input.ownerSessionId }),
        },
      };
    });
  }

  /**
   * What became of a checkout this daemon declared but may never have finished making.
   *
   * IT ASKS THE DISK, and it asks the same questions a removal would: is the directory there, is it
   * a linked worktree of the recorded repository, is it on the recorded branch, and does the
   * ownership marker hold the token the intent minted. Only all four make it ours. Anything else at
   * that path is reported as unverified rather than adopted OR discarded — adopting it would hand a
   * `git worktree remove` to a directory somebody else may own, and discarding the row is what makes
   * a leftover directory invisible.
   */
  async adopt(intent: ManagedWorktreeIntent): Promise<ManagedWorktreeAdoption> {
    if ((await this.fileSystem.type(intent.path)) === 'missing') return { kind: 'absent' };
    const checkout = await this.gateway.inspect(intent.path).catch(
      (error: unknown): GitCheckoutSnapshot => ({
        repo: false,
        kind: 'not_git',
        observedAt: `inspection failed: ${message(error)}`,
      }),
    );
    if (
      !checkout.repo ||
      checkout.kind !== 'linked_worktree' ||
      checkout.gitDir === undefined ||
      checkout.commonDir !== intent.commonDir ||
      checkout.branch !== intent.branch ||
      checkout.detached === true
    ) {
      return { kind: 'unverified', reason: `${intent.path} is not a linked worktree of ${intent.commonDir}` };
    }
    const marker = await this.fileSystem.readText(path.join(checkout.gitDir, OWNERSHIP_MARKER)).catch(() => undefined);
    if (marker !== intent.ownershipToken) {
      return { kind: 'unverified', reason: `${intent.path} carries no ownership marker this daemon minted` };
    }
    return {
      kind: 'adopted',
      managed: {
        version: 1,
        path: intent.path,
        branch: intent.branch,
        repositoryRoot: intent.repositoryRoot,
        commonDir: intent.commonDir,
        gitDir: checkout.gitDir,
        ownershipToken: intent.ownershipToken,
        createdAt: intent.declaredAt,
        initialHead: intent.initialHead,
        branchPreexisted: intent.branchPreexisted,
        sourceCwd: intent.sourceCwd,
        relativeCwd: intent.relativeCwd,
        ...(intent.ownerSessionId === undefined ? {} : { ownerSessionId: intent.ownerSessionId }),
      },
    };
  }

  /** Whether the exact recorded checkout incarnation still occupies its path. */
  async presence(entry: ManagedWorktree): Promise<ManagedWorktreePresence> {
    try {
      const type = await this.fileSystem.type(entry.path);
      if (type === 'missing') return { kind: 'absent' };
      if (type !== 'directory') {
        return { kind: 'unverified', reason: `${entry.path} is now a ${type}, not the recorded checkout` };
      }
      const checkout = await this.gateway.inspect(entry.path);
      if (
        !checkout.repo ||
        checkout.kind !== 'linked_worktree' ||
        checkout.detached === true ||
        checkout.worktreeRoot === undefined ||
        checkout.repositoryRoot === undefined ||
        checkout.gitDir === undefined ||
        checkout.commonDir === undefined ||
        path.resolve(checkout.worktreeRoot) !== path.resolve(entry.path) ||
        path.resolve(checkout.repositoryRoot) !== path.resolve(entry.repositoryRoot) ||
        path.resolve(checkout.gitDir) !== path.resolve(entry.gitDir) ||
        path.resolve(checkout.commonDir) !== path.resolve(entry.commonDir) ||
        checkout.branch !== entry.branch
      ) {
        return { kind: 'unverified', reason: `${entry.path} is not the linked-worktree incarnation on record` };
      }
      const marker = await this.fileSystem.readText(path.join(checkout.gitDir, OWNERSHIP_MARKER));
      return marker === entry.ownershipToken
        ? { kind: 'owned' }
        : { kind: 'unverified', reason: `${entry.path} carries a different ownership token` };
    } catch (error) {
      return { kind: 'unverified', reason: `${entry.path} could not be verified: ${message(error)}` };
    }
  }

  /**
   * Reads one checkout as it is RIGHT NOW: what Git says, and what that means for removing it.
   *
   * ONE PASS FOR BOTH ANSWERS. The list wants live state and the check wants a verdict, and both are
   * read from the same Git invocations — asking separately would cost twice and could return two
   * accounts of one checkout, which is exactly the staleness this surface promises not to have.
   *
   * NOTHING HERE IS CACHED, deliberately. Every field is re-read on every call, so a checkout that
   * somebody dirtied, locked, moved off its branch or deleted by hand between two refreshes reads
   * differently on the second one.
   */
  async examine(input: CheckManagedWorktreeRemovalInput): Promise<ManagedWorktreeInspection> {
    const gitErrors: string[] = [];
    const undetermined: string[] = [];
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
    let branchEvidence: BranchDeletionEvidence | undefined;
    let ahead: number | undefined;
    let behind: number | undefined;
    let integrated: boolean | undefined;
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
        const here = resolvedPath;
        try {
          checkout = await this.gateway.inspect(here);
        } catch (error) {
          gitErrors.push(`checkout inspection failed: ${message(error)}`);
        }
        if (checkout?.repo && checkout.branch !== undefined) {
          const branch = checkout.branch;
          try {
            status = await this.gateway.status(here);
          } catch (error) {
            gitErrors.push(`checkout status failed: ${message(error)}`);
          }
          try {
            pushState = await this.gateway.pushState(here, branch);
          } catch (error) {
            pushState = { kind: 'unknown', reason: `push-state inspection failed: ${message(error)}` };
          }
          const upstream = pushState.kind === 'unknown' ? undefined : pushState.upstream;
          if (upstream === undefined) {
            undetermined.push('no upstream is configured, so ahead and behind counts are unavailable');
          } else {
            try {
              const divergence = await this.gateway.divergence(here, upstream);
              if (divergence === undefined) undetermined.push('Git would not report the divergence counts');
              else ({ ahead, behind } = divergence);
            } catch (error) {
              gitErrors.push(`divergence inspection failed: ${message(error)}`);
            }
          }
          let defaultBranch: string | undefined;
          try {
            defaultBranch = await this.gateway.defaultBranch(here);
          } catch (error) {
            gitErrors.push(`default-branch inspection failed: ${message(error)}`);
          }
          const entries = await this.gateway.list(here).catch((error: unknown) => {
            gitErrors.push(`checkout enumeration failed: ${message(error)}`);
            return [] as readonly WorktreeListEntry[];
          });
          if (defaultBranch === undefined) {
            undetermined.push('no integration target could be resolved, so integration is unproven');
          } else {
            // Publication and integration are different facts. A pushed feature tracks its own
            // `origin/feature/x`; testing against that upstream would call it integrated merely for
            // having been pushed. Integration is always against the repository default branch.
            try {
              integrated = await this.gateway.isIntegrated(here, branch, defaultBranch);
              if (integrated === undefined) undetermined.push('Git would not say whether the branch is integrated');
            } catch (error) {
              gitErrors.push(`integration inspection failed: ${message(error)}`);
            }
          }
          branchEvidence = {
            protectedBranch: branch === entries[0]?.branch || branch === branchOfTrackingName(defaultBranch),
            checkedOut: checkedOutElsewhere(entries, branch, here),
            activeCheckout: input.ownerActive,
            liveTerminals: input.liveTerminals ?? 0,
            branchPreexisted: input.managed.branchPreexisted,
            commitsPushed: pushState.kind === 'pushed',
            integrated: integrated === true,
          };
        }
        if (status === undefined) undetermined.push('the working tree status could not be read');
      }
    }
    if (checkout === undefined) undetermined.push('the checkout could not be inspected');
    // Host evidence the CALLER could not establish is said here too: the list's own account of what
    // it does not know must not be narrower than the refusals the same refresh produced.
    undetermined.push(...(input.undeterminedEvidence ?? []), ...gitErrors);

    const decision = assessWorktreeRemoval({
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
      branchEvidence,
      branchConfirmations: input.confirmations ?? [],
      ...(input.undeterminedEvidence === undefined ? {} : { undeterminedEvidence: input.undeterminedEvidence }),
      gitErrors,
    });

    const live: WorktreeLiveState = {
      ...(checkout?.head === undefined ? {} : { head: checkout.head }),
      ...(checkout?.branch === undefined ? {} : { branch: checkout.branch }),
      detached: checkout?.detached === true,
      ...(status === undefined ? {} : { status }),
      ...(decision.upstream === undefined ? {} : { upstream: decision.upstream }),
      ...(ahead === undefined ? {} : { ahead }),
      ...(behind === undefined ? {} : { behind }),
      ...(checkout?.locked === undefined ? {} : { locked: checkout.locked }),
      ...(checkout?.prunable === undefined ? {} : { prunable: checkout.prunable }),
      ...(integrated === undefined ? {} : { integrated }),
      undetermined,
    };
    return { live, decision, ...(branchEvidence === undefined ? {} : { branchEvidence }) };
  }

  /**
   * Removes one checkout, and its branch when that was asked for and can be justified.
   *
   * THE PREFLIGHT RUNS TWICE AND THE SECOND ONE IS THE POINT. Between the verdict a caller
   * authorized and the moment Git is asked to destroy anything, an agent can dirty the tree, another
   * session can move in, or somebody can lock the checkout. The second pass runs inside the same
   * per-repository queue immediately before the mutation, and ANY change to the blocker set — not
   * merely one that adds an uncleared blocker — refuses: consent was given against a specific account
   * of what would be lost, and a different account is not the thing that was consented to.
   */
  async remove(input: RemoveManagedWorktreeInput): Promise<RemovedManagedWorktree> {
    return await this.queue.run(input.managed.commonDir, async () => {
      const preflight = await this.examine(input);
      const uncleared = unclearedRemovalBlockers(preflight.decision.blockers, input.overrides);
      if (uncleared.length > 0) {
        throw new WorktreeRemovalRefusal(
          `refusing to remove ${preflight.decision.path}: ${describe(uncleared)}`,
          uncleared,
        );
      }

      const fresh = await this.examine((await input.refreshEvidence?.()) ?? input);
      if (blockerFingerprint(fresh.decision.blockers) !== blockerFingerprint(preflight.decision.blockers)) {
        throw new WorktreeRemovalRefusal(
          `refusing to remove ${preflight.decision.path}: the checkout changed after the preflight`,
          fresh.decision.blockers,
        );
      }

      // Git's own refusal of a dirty tree is answered only by the consent that already covered it.
      const discarding = fresh.decision.blockers.some(blocker => blocker.override === 'discard_worktree_changes');
      await this.#withPinned(
        fresh.decision.path,
        () =>
          new WorktreeRemovalRefusal(
            `refusing to remove ${fresh.decision.path}: checkout identity changed at the mutation boundary`,
            fresh.decision.blockers,
          ),
        async pinnedCwd => await this.gateway.remove(pinnedCwd, discarding),
      );
      const retained = { path: fresh.decision.path, branch: input.managed.branch, removedAt: this.clock.nowIso() };
      if (!input.deleteBranch) return { ...retained, branchRetained: true, branchBlockers: [] };

      // The evidence is the one this removal was decided from, and its `checkedOut` already excluded
      // the checkout that just went — so it describes the repository as it is now, not as it was.
      const evidence: BranchDeletionEvidence = fresh.branchEvidence ?? {
        protectedBranch: false,
        checkedOut: false,
        activeCheckout: input.ownerActive,
        liveTerminals: input.liveTerminals ?? 0,
        branchPreexisted: input.managed.branchPreexisted,
        commitsPushed: false,
        integrated: false,
      };
      const verdict = assessBranchDeletion(evidence, input.confirmations ?? []);
      if (!verdict.deletable) return { ...retained, branchRetained: true, branchBlockers: verdict.blockers };
      const deletion = await this.#deleteBranch(
        input.managed.repositoryRoot,
        input.managed.branch,
        !evidence.integrated,
      );
      if (deletion.branchRetained === undefined) {
        throw new WorktreeError(
          'verification_failed',
          `the checkout was removed, but the branch outcome is unknown: ${deletion.errors.join('; ')}`,
        );
      }
      return {
        ...retained,
        branchRetained: deletion.branchRetained,
        branchBlockers: deletion.errors.map(error => ({ code: 'git_error' as const, message: error })),
      };
    });
  }

  /** Delete one branch and prove the ref outcome before releasing the repository capability. */
  async #deleteBranch(
    repositoryRoot: string,
    branch: string,
    force: boolean,
  ): Promise<{ readonly branchRetained: boolean | undefined; readonly errors: readonly string[] }> {
    const errors: string[] = [];
    let branchRetained: boolean | undefined = true;
    let attempted = false;
    let pinned: Awaited<ReturnType<WorktreeDirectoryPinner['pin']>> | undefined;
    try {
      pinned = await this.pinner.pin(repositoryRoot);
      if (path.resolve(pinned.rootReal) !== path.resolve(repositoryRoot)) {
        errors.push('repository identity changed before branch deletion');
      } else {
        attempted = true;
        try {
          await this.gateway.deleteBranch(pinned.policyCwd, branch, force);
        } catch (error) {
          errors.push(`branch deletion failed: ${message(error)}`);
        }
        try {
          branchRetained = await this.gateway.localBranchExists(pinned.policyCwd, branch);
          if (branchRetained && errors.length === 0) {
            errors.push('branch deletion reported success, but the branch still exists');
          }
        } catch (error) {
          branchRetained = undefined;
          errors.push(`branch outcome probe failed: ${message(error)}`);
        }
      }
    } catch (error) {
      errors.push(`branch deletion could not start: ${message(error)}`);
      branchRetained = attempted ? undefined : true;
    } finally {
      if (pinned !== undefined) {
        try {
          await pinned.close();
        } catch (error) {
          errors.push(`branch-deletion pin release failed: ${message(error)}`);
        }
      }
    }
    return { branchRetained, errors };
  }

  /**
   * Pins an exact directory through the final Git spawn, refusing a replacement seen at the edge.
   *
   * If the name was swapped before `pin`, `rootReal` differs and the mutation never starts. If it is
   * swapped after `pin`, Git inherits the already-open directory and cannot follow the replacement.
   */
  async #withPinned<Result>(
    expected: string,
    mismatch: () => Error,
    use: (cwd: GitWorkingDirectory) => Promise<Result>,
  ): Promise<Result> {
    const pinned = await this.pinner.pin(expected);
    try {
      if (path.resolve(pinned.rootReal) !== path.resolve(expected)) throw mismatch();
      return await use(pinned.policyCwd);
    } finally {
      await pinned.close();
    }
  }
}
