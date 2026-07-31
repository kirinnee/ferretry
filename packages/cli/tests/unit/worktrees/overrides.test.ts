import { describe, it } from 'bun:test';
import should from 'should';
import {
  grantedConfirmations,
  grantedOverrides,
  mayRemove,
  unclearedBlockers,
} from '../../../src/lib/worktrees/overrides';
import { blocker, decision } from './fixtures';

describe('removal consent', () => {
  it('should grant nothing when no consent flag was passed', () => {
    // Act + Assert
    should(grantedOverrides({})).eql([]);
    should(grantedOverrides({ deleteBranch: true, yes: true } as never)).eql([]);
  });

  it('should grant exactly the override each flag names', () => {
    // Act + Assert
    should(grantedOverrides({ discardChanges: true })).eql(['discard_worktree_changes']);
    should(grantedOverrides({ acceptUnpushed: true })).eql(['accept_unpushed_commits']);
    should(grantedOverrides({ deleteUnmerged: true })).eql(['delete_unmerged_branch']);
  });

  it('should grant several overrides when several flags were passed', () => {
    // Act
    const granted = grantedOverrides({ discardChanges: true, acceptUnpushed: true, deleteUnmerged: true });

    // Assert
    should(granted).eql(['discard_worktree_changes', 'accept_unpushed_commits', 'delete_unmerged_branch']);
  });
});

describe('branch deletion confirmations', () => {
  it('should confirm nothing unless the branch is actually being deleted', () => {
    // Act + Assert
    should(grantedConfirmations({ deletePreexisting: true, acceptUnpushed: true, deleteUnmerged: true })).eql([]);
  });

  it('should carry each confirmation the caller granted', () => {
    // Act
    const confirmations = grantedConfirmations({
      deleteBranch: true,
      deletePreexisting: true,
      acceptUnpushed: true,
      deleteUnmerged: true,
    });

    // Assert
    should(confirmations).eql(['delete_preexisting_branch', 'delete_unpushed_branch', 'delete_unmerged_branch']);
  });

  it('should confirm nothing extra for a plain branch deletion', () => {
    // Act + Assert
    should(grantedConfirmations({ deleteBranch: true })).eql([]);
  });
});

describe('blockers that survive the consent given', () => {
  it('should leave nothing uncleared when the daemon reported none', () => {
    // Act + Assert
    should(unclearedBlockers(decision(), [])).eql([]);
    should(mayRemove(decision(), [])).be.true();
  });

  it('should clear a blocker the caller consented to', () => {
    // Arrange
    const verdict = decision({ removable: false, blockers: [blocker()] });

    // Act + Assert
    should(unclearedBlockers(verdict, ['discard_worktree_changes'])).be.empty();
    should(mayRemove(verdict, ['discard_worktree_changes'])).be.true();
  });

  it('should keep a blocker whose override was not granted, naming the flag that would', () => {
    // Arrange
    const verdict = decision({ removable: false, blockers: [blocker()] });

    // Act
    const uncleared = unclearedBlockers(verdict, ['accept_unpushed_commits']);

    // Assert
    should(uncleared).have.length(1);
    should(uncleared[0]?.flag).equal('--discard-changes');
    should(mayRemove(verdict, ['accept_unpushed_commits'])).be.false();
  });

  it('should keep a blocker nothing can override, and say so', () => {
    // Arrange — another session is working here; no flag makes that safe
    const verdict = decision({
      removable: false,
      blockers: [blocker({ code: 'active_session', message: 'a session is running here', override: undefined })],
    });

    // Act
    const uncleared = unclearedBlockers(verdict, [
      'discard_worktree_changes',
      'accept_unpushed_commits',
      'delete_unmerged_branch',
    ]);

    // Assert
    should(uncleared).have.length(1);
    should(uncleared[0]?.flag).be.undefined();
    should(mayRemove(verdict, ['discard_worktree_changes'])).be.false();
  });

  it('should name every flag that is still missing, not just the first', () => {
    // Arrange
    const verdict = decision({
      removable: false,
      blockers: [
        blocker(),
        blocker({
          code: 'unpushed_commits',
          message: 'commits exist nowhere else',
          override: 'accept_unpushed_commits',
        }),
        blocker({
          code: 'unmerged_branch',
          message: 'the branch was never merged',
          override: 'delete_unmerged_branch',
        }),
      ],
    });

    // Act
    const flags = unclearedBlockers(verdict, []).map(entry => entry.flag);

    // Assert
    should(flags).eql(['--discard-changes', '--accept-unpushed', '--delete-unmerged']);
  });

  it('should trust a daemon that already declared the removal safe', () => {
    // Arrange — the daemon may report advisory blockers alongside removable: true
    const verdict = decision({ removable: true, blockers: [blocker({ override: undefined })] });

    // Act + Assert
    should(mayRemove(verdict, [])).be.true();
    should(unclearedBlockers(verdict, [])).have.length(1);
  });
});
