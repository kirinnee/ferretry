import { describe, it } from 'bun:test';
import should from 'should';
import { unclearedBlockers } from '../../../src/lib/worktrees/overrides';
import {
  renderBlocker,
  renderCreated,
  renderRemovalDecision,
  renderRemoved,
  renderWorktreeList,
  renderWorktreeRow,
} from '../../../src/lib/worktrees/render';
import { blocker, created, decision, listResponse, live, removed, worktree, WORKTREE_PATH } from './fixtures';

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

describe('live state rendering', () => {
  it('should show where the checkout actually is now, not only where it started', () => {
    // Act
    const rendered = renderWorktreeRow(worktree());

    // Assert — the created-at commit and the live HEAD are different facts
    should(rendered).containEql(`HEAD ${'b'.repeat(12)}`);
    should(rendered).containEql('on port/cli-remaining');
    should(rendered).containEql('clean');
    should(rendered).containEql('origin/port/cli-remaining · 2 ahead, 1 behind');
    should(rendered).containEql('not integrated');
    should(rendered).containEql('safe to remove');
  });

  it('should name every kind of content the checkout is holding', () => {
    // Act
    const rendered = renderWorktreeRow(
      worktree({
        live: live({
          status: {
            staged: true,
            unstaged: true,
            untracked: true,
            ignored: true,
            conflicted: true,
            dirtySubmodule: true,
            truncated: false,
          },
        }),
      }),
    );

    // Assert
    should(rendered).containEql('staged, unstaged, untracked, ignored, conflicted, dirty submodule');
  });

  it('should say what it could not determine rather than showing a zero it never read', () => {
    // Act
    const noUpstream = renderWorktreeRow(
      worktree({
        live: live({
          upstream: undefined,
          ahead: undefined,
          behind: undefined,
          integrated: undefined,
          status: undefined,
          head: undefined,
          undetermined: ['no upstream is configured, so ahead and behind counts are unavailable'],
        }),
      }),
    );
    const noCounts = renderWorktreeRow(worktree({ live: live({ ahead: undefined }) }));

    // Assert
    should(noUpstream).containEql('HEAD unknown');
    should(noUpstream).containEql('content unknown');
    should(noUpstream).containEql('no upstream');
    should(noUpstream).containEql('integration unproven');
    should(noUpstream).containEql('? no upstream is configured');
    should(noCounts).containEql('divergence unknown');
  });

  it('should mark a locked, prunable or detached checkout', () => {
    // Act
    const rendered = renderWorktreeRow(
      worktree({
        live: live({ detached: true, branch: undefined, locked: 'held by a release', prunable: 'gitdir is gone' }),
      }),
    );
    const bareLock = renderWorktreeRow(worktree({ live: live({ locked: '' }) }));

    // Assert
    should(rendered).containEql('detached');
    should(rendered).containEql('locked (held by a release)');
    should(rendered).containEql('prunable');
    should(bareLock).containEql('locked ·');
  });

  it('should count the blockers when the checkout may not go', () => {
    // Act
    const rendered = renderWorktreeRow(
      worktree({ removal: decision({ removable: false, blockers: [blocker(), blocker()] }) }),
    );

    // Assert
    should(rendered).containEql('2 blockers');
  });

  it('should say when a row is an unfinished creation rather than rendering it as a checkout', () => {
    // Act
    const rendered = renderWorktreeRow(
      worktree({ live: undefined, removal: undefined, unresolved: 'declared at X and never finished' }),
    );

    // Assert
    should(rendered).containEql('! unfinished: declared at X and never finished');
  });

  it('should show a row with no live evidence without inventing any', () => {
    // Act
    const rendered = renderWorktreeRow(worktree({ live: live({ branch: undefined }), removal: undefined }));

    // Assert
    should(rendered).containEql('on an unreadable branch');
    should(rendered).containEql('removal unassessed');
  });

  it('should join a worktree to its Project when the daemon found one', () => {
    // Act + Assert
    should(renderWorktreeRow(worktree({ projectId: 'proj-1' }))).containEql('project proj-1');
  });
});

describe('branch-deletion rendering', () => {
  it('should say the branch can go with the checkout', () => {
    // Act + Assert
    should(renderRemovalDecision(decision(), [])).containEql('branch port/cli-remaining can be deleted with it');
  });

  it('should name each confirmation a kept branch would need', () => {
    // Act
    const rendered = renderRemovalDecision(
      decision({
        branchDeletion: {
          deletable: false,
          blockers: [
            {
              code: 'unmerged_branch',
              message: 'the branch is not integrated',
              confirmation: 'delete_unmerged_branch',
            },
            { code: 'protected_branch', message: 'the protected branch cannot be deleted' },
          ],
        },
      }),
      [],
    );

    // Assert
    should(rendered).containEql('branch port/cli-remaining would be kept');
    should(rendered).containEql('confirm with --delete-branch --delete-unmerged');
    should(rendered).containEql('nothing confirms this');
  });

  it('should render a granted branch confirmation as clearing its blocker', () => {
    // Arrange
    const verdict = decision({
      branchDeletion: {
        deletable: false,
        blockers: [
          { code: 'unmerged_branch', message: 'the branch is not integrated', confirmation: 'delete_unmerged_branch' },
        ],
      },
    });

    // Act + Assert
    should(renderRemovalDecision(verdict, [], ['delete_unmerged_branch'])).containEql(
      'branch port/cli-remaining can be deleted with it',
    );
  });

  it('should say plainly when the price of deleting the branch could not be read', () => {
    // Act + Assert
    should(renderRemovalDecision(decision({ branchDeletion: undefined }), [])).containEql(
      'branch deletion could not be assessed',
    );
  });

  it('should report the blockers behind a branch the removal kept', () => {
    // Act
    const rendered = renderRemoved(
      removed({ branchBlockers: [{ code: 'unpushed_commits', message: 'the branch has unpushed commits' }] }),
    );

    // Assert — a removal that silently kept the branch is the dead-flag bug all over again
    should(rendered).containEql('✗ unpushed_commits: the branch has unpushed commits');
  });
});

describe('fork confirmation rendering', () => {
  it('should say where the checkout is and where to start work in it', () => {
    // Act
    const rendered = renderCreated(created());

    // Assert
    should(rendered).containEql('created /managed/ferretry-new on branch feat/new');
    should(rendered).containEql(`from ${'a'.repeat(12)} · start work in /managed/ferretry-new/packages/cli`);
  });
});
