import { describe, it } from 'bun:test';
import should from 'should';
import { unclearedBlockers } from '../../../src/lib/worktrees/overrides';
import {
  renderBlocker,
  renderRemovalDecision,
  renderRemoved,
  renderWorktreeList,
  renderWorktreeRow,
} from '../../../src/lib/worktrees/render';
import { blocker, decision, listResponse, removed, worktree, WORKTREE_PATH } from './fixtures';

describe('worktree list rendering', () => {
  it('should say plainly that the daemon holds nothing', () => {
    // Act + Assert
    should(renderWorktreeList(listResponse([]))).equal('No managed worktrees under /managed.');
    should(renderWorktreeList(listResponse([], null))).equal('No managed worktrees.');
  });

  it('should show who owns a worktree and whether they are still working', () => {
    // Act
    const rendered = renderWorktreeRow(worktree());

    // Assert
    should(rendered).containEql(WORKTREE_PATH);
    should(rendered).containEql('branch port/cli-remaining · created 2026-07-31T09:00:00.000Z');
    should(rendered).containEql('owner ms8ucu18-1eb5331d (active)');
  });

  it('should mark an ownerless or ended worktree rather than implying it is in use', () => {
    // Act
    const orphaned = renderWorktreeRow(worktree({ ownerSessionId: undefined, ownerActive: false }));

    // Assert
    should(orphaned).containEql('no owner (ended)');
  });

  it('should name the other sessions sharing a worktree', () => {
    // Act
    const shared = renderWorktreeRow(worktree({ sharedWith: ['a', 'b'] }));

    // Assert
    should(shared).containEql('shared with a, b');
  });

  it('should mark a branch that existed before the worktree did', () => {
    // Act + Assert
    should(renderWorktreeRow(worktree({ branchPreexisted: true }))).containEql('(pre-existing)');
  });

  it('should keep removed worktrees in their own section, not beside live ones', () => {
    // Arrange
    const tombstone = worktree({ path: '/managed/old', removedAt: '2026-07-30T09:00:00.000Z' });

    // Act
    const rendered = renderWorktreeList(listResponse([worktree(), tombstone]));

    // Assert
    should(rendered.split('\n')[0]).equal('1 managed worktree under /managed');
    should(rendered).containEql('1 removed worktree still recorded');
    should(rendered).containEql('removed 2026-07-30T09:00:00.000Z');
    should(rendered.indexOf(WORKTREE_PATH)).be.below(rendered.indexOf('/managed/old'));
  });

  it('should say there are no live worktrees when only tombstones remain', () => {
    // Act
    const rendered = renderWorktreeList(listResponse([worktree({ removedAt: '2026-07-30T09:00:00.000Z' })], null));

    // Assert
    should(rendered.split('\n')[0]).equal('No live managed worktrees.');
  });

  it('should pluralise the live count correctly', () => {
    // Act
    const rendered = renderWorktreeList(listResponse([worktree(), worktree({ path: '/managed/two' })]));

    // Assert
    should(rendered.split('\n')[0]).equal('2 managed worktrees under /managed');
  });
});

describe('removal verdict rendering', () => {
  it('should say a clean worktree is safe to remove', () => {
    // Act
    const rendered = renderRemovalDecision(decision(), []);

    // Assert
    should(rendered).containEql('branch port/cli-remaining → origin/port/cli-remaining');
    should(rendered).containEql('✓ safe to remove');
  });

  it('should say when a branch has no upstream, rather than omitting the fact', () => {
    // Act + Assert
    should(renderRemovalDecision(decision({ upstream: undefined }), [])).containEql('no upstream');
  });

  it('should list every blocker with the flag that clears it', () => {
    // Arrange
    const verdict = decision({ removable: false, blockers: [blocker()] });

    // Act
    const rendered = renderRemovalDecision(verdict, unclearedBlockers(verdict, []));

    // Assert
    should(rendered).containEql('1 blocker:');
    should(rendered).containEql('✗ unstaged_changes: the worktree has uncommitted edits — pass --discard-changes');
  });

  it('should say plainly when nothing overrides a blocker', () => {
    // Act
    const rendered = renderBlocker({
      code: 'active_session',
      message: 'a session is running here',
      flag: undefined,
    });

    // Assert
    should(rendered).equal('  ✗ active_session: a session is running here — nothing overrides this');
  });

  it('should pluralise the blocker count', () => {
    // Arrange
    const verdict = decision({
      removable: false,
      blockers: [blocker(), blocker({ code: 'untracked_content', override: undefined })],
    });

    // Act + Assert
    should(renderRemovalDecision(verdict, unclearedBlockers(verdict, []))).containEql('2 blockers:');
  });
});

describe('removal confirmation rendering', () => {
  it('should state that the branch outlived the worktree', () => {
    // Act + Assert
    should(renderRemoved(removed())).equal(
      `removed ${WORKTREE_PATH} at 2026-07-31T10:00:00.000Z — branch port/cli-remaining kept`,
    );
  });

  it('should state that the branch went with it', () => {
    // Act + Assert
    should(renderRemoved(removed({ branchRetained: false }))).containEql('branch port/cli-remaining deleted');
  });
});
