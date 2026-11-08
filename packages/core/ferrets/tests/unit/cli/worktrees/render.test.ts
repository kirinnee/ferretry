import { expect, test } from 'bun:test';
import { renderRemovalDecision, renderWorktreeList } from '../../../../cli/lib/worktrees/render.ts';
import { decision, listResponse, worktree } from './fixtures.ts';

const blockedBranch = decision({
  branchDeletion: {
    deletable: false,
    blockers: [
      {
        code: 'preexisting_branch',
        message: 'the branch existed before the worktree',
        confirmation: 'delete_preexisting_branch',
      },
      { code: 'unpushed_commits', message: 'two commits are not pushed', confirmation: 'delete_unpushed_branch' },
      { code: 'unmerged_branch', message: 'the branch is not merged', confirmation: 'delete_unmerged_branch' },
      { code: 'protected_branch', message: 'the branch is protected' },
    ],
  },
});

test('a live worktree whose removal was never assessed says removal unassessed', () => {
  const text = renderWorktreeList(listResponse([worktree({ removal: undefined })]));
  expect(text).toContain('removal unassessed');
  expect(text).not.toContain('safe to remove');
});

test('a live worktree with blockers on its removal says how many', () => {
  const text = renderWorktreeList(
    listResponse([
      worktree({
        removal: decision({
          removable: false,
          blockers: [
            { code: 'unstaged_changes', message: 'edits', override: 'discard_worktree_changes' },
            { code: 'untracked_content', message: 'new files', override: 'discard_worktree_changes' },
          ],
        }),
      }),
    ]),
  );
  expect(text).toContain('2 blockers');
});

test('a removed worktree is listed after the live ones as still recorded', () => {
  const text = renderWorktreeList(
    listResponse([
      worktree({ path: '/managed/live' }),
      worktree({ path: '/managed/gone', removedAt: '2026-07-31T11:00:00.000Z' }),
    ]),
  );
  const lines = text.split('\n');
  expect(lines[0]).toBe('1 managed worktree under /managed');
  expect(lines).toContain('1 removed worktree still recorded');
  expect(text).toContain('removed 2026-07-31T11:00:00.000Z');
  expect(text.indexOf('/managed/live')).toBeLessThan(text.indexOf('/managed/gone'));
});

test('a removal check names every branch blocker with the flag that confirms it, or says nothing does', () => {
  const text = renderRemovalDecision(blockedBranch, []);
  expect(text).toContain('branch port/cli-remaining would be kept:');
  expect(text).toContain(
    '✗ preexisting_branch: the branch existed before the worktree — confirm with --delete-branch --delete-preexisting',
  );
  expect(text).toContain(
    '✗ unpushed_commits: two commits are not pushed — confirm with --delete-branch --accept-unpushed',
  );
  expect(text).toContain(
    '✗ unmerged_branch: the branch is not merged — confirm with --delete-branch --delete-unmerged',
  );
  expect(text).toContain('✗ protected_branch: the branch is protected — nothing confirms this');
});

test('a branch blocker already confirmed is not listed again, and none left means the branch can go with it', () => {
  const confirmed = renderRemovalDecision(
    blockedBranch,
    [],
    ['delete_preexisting_branch', 'delete_unpushed_branch', 'delete_unmerged_branch'],
  );
  expect(confirmed).not.toContain('preexisting_branch');
  expect(confirmed).toContain('✗ protected_branch');
  const clear = renderRemovalDecision(decision(), []);
  expect(clear).toContain('branch port/cli-remaining can be deleted with it');
});

test('a removal check that could not price the branch says so', () => {
  expect(renderRemovalDecision(decision({ branchDeletion: undefined }), [])).toContain(
    'branch deletion could not be assessed',
  );
});
