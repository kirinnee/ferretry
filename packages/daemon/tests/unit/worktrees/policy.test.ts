import { describe, it } from 'bun:test';
import should from 'should';
import {
  assessBranchDeletion,
  assessWorktreeRemoval,
  hasDirtyWorktree,
  isCheckoutLocked,
  isCurrentCheckout,
  isPathInside,
  requiredRemovalOverride,
  sharingSessionIds,
  type WorktreeRemovalEvidence,
  type WorktreeStatusSummary,
} from '../../../src/lib/worktrees/index.ts';

const cleanStatus: WorktreeStatusSummary = {
  staged: false,
  unstaged: false,
  untracked: false,
  ignored: false,
  conflicted: false,
  dirtySubmodule: false,
  truncated: false,
};

const safeEvidence = (overrides: Partial<WorktreeRemovalEvidence> = {}): WorktreeRemovalEvidence => ({
  recordedPath: '/managed/repo',
  managedRoot: '/managed',
  resolvedManagedRoot: '/managed',
  resolvedPath: '/managed/repo',
  expectedRepositoryRoot: '/source',
  expectedCommonDir: '/source/.git',
  expectedGitDir: '/source/.git/worktrees/repo',
  expectedBranch: 'feature/safe',
  ownershipMarkerMatches: true,
  ownerActive: false,
  otherSessions: [],
  liveTerminals: 0,
  checkout: {
    repo: true,
    kind: 'linked_worktree',
    worktreeRoot: '/managed/repo',
    repositoryRoot: '/source',
    commonDir: '/source/.git',
    gitDir: '/source/.git/worktrees/repo',
    branch: 'feature/safe',
    detached: false,
    head: 'abc123',
    observedAt: '2026-07-30T00:00:00.000Z',
  },
  status: cleanStatus,
  pushState: { kind: 'pushed', upstream: 'refs/remotes/origin/feature/safe' },
  gitErrors: [],
  ...overrides,
});

describe('worktree safety predicates', () => {
  it.each([
    { parent: '/managed', child: '/managed', expected: true },
    { parent: '/managed', child: '/managed/repo/sub', expected: true },
    { parent: '/managed', child: '/managed-other/repo', expected: false },
    { parent: '/managed', child: '/managed/../outside', expected: false },
  ])('should decide path containment for $child', ({ parent, child, expected }) => {
    // Act
    const actual = isPathInside(parent, child);

    // Assert
    should(actual).equal(expected);
  });

  it('should identify current and shared checkouts without matching path prefixes', () => {
    // Arrange
    const sessions = [
      { id: 'inside', cwd: '/managed/repo/sub' },
      { id: 'prefix-only', cwd: '/managed/repository' },
    ];

    // Act
    const current = isCurrentCheckout('/managed/repo', '/managed/repo/sub');
    const absentCurrent = isCurrentCheckout('/managed/repo', undefined);
    const shared = sharingSessionIds('/managed/repo', sessions);

    // Assert
    should(current).be.true();
    should(absentCurrent).be.false();
    should(shared).deepEqual(['inside']);
  });

  it('should treat a reasonless Git lock as locked', () => {
    // Act + Assert
    should(isCheckoutLocked('')).be.true();
    should(isCheckoutLocked(undefined)).be.false();
  });

  it('should keep clean and dirty summaries distinct', () => {
    // Arrange
    const input = { ...cleanStatus, ignored: true };

    // Act + Assert
    should(hasDirtyWorktree(cleanStatus)).be.false();
    should(hasDirtyWorktree(input)).be.true();
  });

  it.each([
    { code: 'staged_changes' as const, expected: 'discard_worktree_changes' },
    { code: 'unstaged_changes' as const, expected: 'discard_worktree_changes' },
    { code: 'untracked_content' as const, expected: 'discard_worktree_changes' },
    { code: 'ignored_content' as const, expected: 'discard_worktree_changes' },
    { code: 'conflicted_worktree' as const, expected: 'discard_worktree_changes' },
    { code: 'dirty_submodule' as const, expected: 'discard_worktree_changes' },
    { code: 'unpushed_commits' as const, expected: 'accept_unpushed_commits' },
    { code: 'locked_worktree' as const, expected: undefined },
  ])('should map $code to its distinct override', ({ code, expected }) => {
    // Act
    const actual = requiredRemovalOverride(code);

    // Assert
    should(actual).equal(expected);
  });
});

describe('assessWorktreeRemoval', () => {
  it('should allow only a clean, pushed, owned linked worktree', () => {
    // Act
    const actual = assessWorktreeRemoval(safeEvidence());

    // Assert
    should(actual).deepEqual({
      removable: true,
      path: '/managed/repo',
      branch: 'feature/safe',
      head: 'abc123',
      upstream: 'refs/remotes/origin/feature/safe',
      blockers: [],
    });
  });

  it('should refuse active, current, shared, terminal-held, and unowned checkouts independently', () => {
    // Arrange
    const input = safeEvidence({
      ownerActive: true,
      currentWorkingDirectory: '/managed/repo/sub',
      otherSessions: [{ id: 'other', cwd: '/managed/repo' }],
      liveTerminals: 2,
      ownershipMarkerMatches: false,
    });

    // Act
    const actual = assessWorktreeRemoval(input);

    // Assert
    should(actual.blockers.map(item => item.code)).deepEqual([
      'active_session',
      'current_checkout',
      'shared_checkout',
      'live_terminal',
      'ownership_mismatch',
    ]);
  });

  it('should refuse missing, escaped, and replaced checkout paths', () => {
    // Act
    const missing = assessWorktreeRemoval(safeEvidence({ recordedPath: '/outside/repo', resolvedPath: undefined }));
    const replaced = assessWorktreeRemoval(safeEvidence({ resolvedPath: '/outside/replacement' }));

    // Assert
    should(missing.blockers.map(item => item.code)).deepEqual(['outside_managed_root', 'missing_worktree']);
    should(replaced.blockers.map(item => item.code)).deepEqual(['outside_managed_root', 'path_identity_mismatch']);
  });

  it('should refuse primary, mismatched, detached, and locked Git identities', () => {
    // Arrange
    const checkout = {
      ...safeEvidence().checkout!,
      repo: false,
      kind: 'main_checkout' as const,
      repositoryRoot: '/other',
      commonDir: '/other/.git',
      gitDir: '/other/.git',
      branch: 'other',
      detached: true,
      locked: '',
    };

    // Act
    const actual = assessWorktreeRemoval(safeEvidence({ checkout }));

    // Assert
    should(actual.blockers.map(item => item.code)).deepEqual([
      'main_checkout',
      'repository_mismatch',
      'branch_mismatch',
      'locked_worktree',
    ]);
  });

  it('should preserve separate worktree-content blockers and force categories', () => {
    // Arrange
    const status = {
      staged: true,
      unstaged: true,
      untracked: true,
      ignored: true,
      conflicted: true,
      dirtySubmodule: true,
      truncated: true,
    };

    // Act
    const actual = assessWorktreeRemoval(safeEvidence({ status }));

    // Assert
    should(actual.blockers.map(item => item.code)).deepEqual([
      'staged_changes',
      'unstaged_changes',
      'untracked_content',
      'ignored_content',
      'conflicted_worktree',
      'dirty_submodule',
      'git_error',
    ]);
    should(actual.blockers.slice(0, 6).every(item => item.override === 'discard_worktree_changes')).be.true();
  });

  it('should refuse unpushed, indeterminate, and failed Git evidence with diagnostics intact', () => {
    // Act
    const unpushed = assessWorktreeRemoval(
      safeEvidence({ pushState: { kind: 'unpushed', reason: '2 commits ahead', upstream: 'refs/remotes/origin/x' } }),
    );
    const unknown = assessWorktreeRemoval(
      safeEvidence({ pushState: { kind: 'unknown', reason: 'cannot read refs' }, gitErrors: ['status failed'] }),
    );

    // Assert
    should(unpushed.blockers[0]).deepEqual({
      code: 'unpushed_commits',
      message: '2 commits ahead',
      override: 'accept_unpushed_commits',
    });
    should(unknown.upstream).be.undefined();
    should(unknown.blockers.map(item => item.message)).deepEqual(['cannot read refs', 'status failed']);
  });
});

describe('assessBranchDeletion', () => {
  it('should allow an integrated, pushed, newly-created inactive branch', () => {
    // Act
    const actual = assessBranchDeletion({
      protectedBranch: false,
      checkedOut: false,
      activeCheckout: false,
      liveTerminals: 0,
      branchPreexisted: false,
      commitsPushed: true,
      integrated: true,
    });

    // Assert
    should(actual).deepEqual({ deletable: true, blockers: [] });
  });

  it('should keep dirty-worktree and unmerged-branch confirmations distinct', () => {
    // Arrange
    const evidence = {
      protectedBranch: false,
      checkedOut: false,
      activeCheckout: false,
      liveTerminals: 0,
      branchPreexisted: true,
      commitsPushed: false,
      integrated: false,
    };

    // Act
    const blocked = assessBranchDeletion(evidence);
    const confirmed = assessBranchDeletion(evidence, [
      'delete_preexisting_branch',
      'delete_unpushed_branch',
      'delete_unmerged_branch',
    ]);

    // Assert
    should(blocked.deletable).be.false();
    should(blocked.blockers.map(item => item.confirmation)).deepEqual([
      'delete_preexisting_branch',
      'delete_unpushed_branch',
      'delete_unmerged_branch',
    ]);
    should(confirmed.deletable).be.true();
  });

  it('should never make protected, checked-out, active, or terminal-held branches confirmable', () => {
    // Arrange
    const evidence = {
      protectedBranch: true,
      checkedOut: true,
      activeCheckout: true,
      liveTerminals: 1,
      branchPreexisted: false,
      commitsPushed: true,
      integrated: true,
    };

    // Act
    const actual = assessBranchDeletion(evidence, ['delete_unmerged_branch']);

    // Assert
    should(actual.deletable).be.false();
    should(actual.blockers.map(item => item.code)).deepEqual([
      'protected_branch',
      'branch_checked_out',
      'active_checkout',
      'live_terminal',
    ]);
    should(actual.blockers.every(item => item.confirmation === undefined)).be.true();
  });
});
