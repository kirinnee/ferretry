import { describe, expect, test } from 'bun:test';
import type { RepoWorktreeRow, WorktreeRemovalDecision } from '@ferretry/core-ferrets/contract';
import type { BranchPullResult } from '@ferretry/plugin-pulls/contract';
import { worktreeVerdict } from '../../daemon/lib/worktrees/verdict.ts';

const head = 'a'.repeat(40);
const row: RepoWorktreeRow = {
  path: '/synthetic/worktree',
  main: false,
  bare: false,
  tracked: 'adopted',
  ferrets: [],
  live: {
    head,
    branch: 'feature',
    detached: false,
    upstream: 'origin/feature',
    ahead: 0,
    behind: 0,
    undetermined: [],
    status: {
      staged: false,
      unstaged: false,
      untracked: false,
      ignored: false,
      conflicted: false,
      dirtySubmodule: false,
      truncated: false,
    },
  },
};
const pull: BranchPullResult = {
  branch: 'feature',
  outcome: 'pull',
  pull: {
    number: 1,
    state: 'merged',
    headSha: head,
    createdAt: '2026-11-01T00:00:00.000Z',
    mergedAt: '2026-11-02T00:00:00.000Z',
    url: 'https://github.com/synthetic/repo/pull/1',
  },
};
const removal: WorktreeRemovalDecision = { path: row.path, branch: 'feature', head, removable: true, blockers: [] };

describe('positive merged evidence and local safety are both required', () => {
  test('a tracked, clean, pushed, idle checkout at the merged head can go, including a squash merge', () => {
    expect(worktreeVerdict(row, pull, removal).removable).toBe(true);
    expect(worktreeVerdict({ ...row, live: { ...row.live, integrated: false } }, pull, removal).removable).toBe(true);
  });
  test.each([
    undefined,
    { branch: 'feature', outcome: 'none' },
    { branch: 'feature', outcome: 'unknown', code: 'pulls_github_error' },
    { branch: 'feature', outcome: 'unknown', code: 'pulls_paused' },
    { ...pull, branch: 'another' },
    { ...pull, pull: { ...pull.pull, state: 'open' } },
    { ...pull, pull: { ...pull.pull, state: 'closed' } },
    { ...pull, pull: { ...pull.pull, headSha: 'b'.repeat(40) } },
  ] as (BranchPullResult | undefined)[])(
    'none, empty, error, open, closed or mismatched PR evidence keeps the tree: %j',
    pr => {
      expect(worktreeVerdict(row, pr, removal).removable).toBe(false);
    },
  );
  test.each([
    { main: true },
    { bare: true },
    { tracked: 'none' },
    { ferrets: undefined },
    { ferrets: [{ id: 'live', active: true }] },
    ...[
      { detached: true },
      { head: undefined },
      { branch: undefined },
      { upstream: undefined },
      { ahead: 1 },
      { ahead: undefined },
      { locked: '' },
      { prunable: '' },
      { undetermined: ['unreadable'] },
      { status: undefined },
      ...['staged', 'unstaged', 'untracked', 'conflicted', 'dirtySubmodule', 'ignored', 'truncated'].map(key => ({
        status: { ...row.live.status!, [key]: true },
      })),
    ].map(live => ({ live: { ...row.live, ...live } })),
  ] as Partial<RepoWorktreeRow>[])('each unsafe or unknown local fact keeps the tree: %j', change => {
    expect(worktreeVerdict({ ...row, ...change }, pull, removal).removable).toBe(false);
  });
  test('the existing removal check must positively agree; stopped ferrets do not block', () => {
    expect(
      worktreeVerdict({ ...row, live: { ...row.live, status: { ...row.live.status!, ignored: true } } }, pull, removal),
    ).toEqual({ removable: false, reason: 'kept: ignored files present' });
    expect(worktreeVerdict(row, pull, undefined).removable).toBe(false);
    expect(
      worktreeVerdict(row, pull, {
        ...removal,
        removable: false,
        blockers: [{ code: 'live_terminal', message: 'a shell is here' }],
      }),
    ).toEqual({ removable: false, reason: 'a shell is here' });
    expect(worktreeVerdict(row, pull, { ...removal, head: 'b'.repeat(40) }).removable).toBe(false);
    expect(worktreeVerdict({ ...row, ferrets: [{ id: 'stopped', active: false }] }, pull, removal).removable).toBe(
      true,
    );
  });
});
