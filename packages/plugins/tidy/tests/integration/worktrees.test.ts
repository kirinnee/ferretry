import { describe, expect, test } from 'bun:test';
import type { RepoWorktreeRow, WorktreeRemovalRequest } from '@ferretry/core-ferrets/contract';
import { ProjectInfoSchema } from '@ferretry/plugin-projects/contract';
import type { BranchPullResult } from '@ferretry/plugin-pulls/contract';
import { TidyWorktreesService } from '../../daemon/lib/worktrees/service.ts';

function fixture() {
  const head = 'a'.repeat(40);
  const project = ProjectInfoSchema.parse({
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Synthetic',
    path: '/synthetic/repo',
    source: 'existing-folder',
    createdAt: '2026-11-01T00:00:00.000Z',
    git: { commonDirectory: '/synthetic/repo/.git' },
    repos: [{ path: '.', provider: 'github', remote: 'https://github.com/synthetic/repo' }],
  });
  const tree: RepoWorktreeRow = {
    path: '/synthetic/tree',
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
      integrated: false,
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
  const merged: BranchPullResult = {
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
  let rows = [tree];
  let answers: readonly BranchPullResult[] = [merged];
  let error = false;
  const calls: WorktreeRemovalRequest[] = [];
  const service = new TidyWorktreesService({
    projects: () => ({ find: async id => (id === project.id ? project : undefined) }),
    pulls: () => ({
      branchPulls: async () => {
        if (error) throw new Error('synthetic unavailable');
        return answers;
      },
    }),
    ferrets: {
      repoWorktrees: async commonDirectory => ({
        commonDirectory,
        worktrees: rows,
        total: rows.length,
        truncated: false,
      }),
      checkWorktreeRemoval: async (path, cwd) => ({
        path,
        branch: 'feature',
        head,
        removable: path !== cwd,
        blockers: path === cwd ? [{ code: 'current_checkout', message: 'caller is here' }] : [],
      }),
      removeWorktree: async request => {
        calls.push(request);
        rows = rows.filter(row => row.path !== request.path);
        return {
          path: request.path,
          branch: 'feature',
          branchRetained: false,
          removedAt: '2026-11-02T00:00:00.000Z',
          branchBlockers: [],
        };
      },
    },
  });
  return {
    project,
    tree,
    merged,
    service,
    calls,
    setRows: (next: RepoWorktreeRow[]) => {
      rows = next;
    },
    setPulls: (next: readonly BranchPullResult[]) => {
      answers = next;
    },
    failPulls: () => {
      error = true;
    },
  };
}

describe('Tidy composes only the published contracts', () => {
  test('read-only verdict delegates safety, and apply sends only expected-head and branch confirmations', async () => {
    const w = fixture();
    expect((await w.service.list(w.project.id)).rows[0]?.verdict.removable).toBe(true);
    expect(w.calls).toEqual([]);
    const applied = await w.service.remove(w.project.id, [w.tree.path]);
    expect(applied.removed).toHaveLength(1);
    expect(w.calls).toEqual([
      {
        path: w.tree.path,
        expectedHead: w.tree.live.head,
        overrides: [],
        deleteBranch: true,
        confirmations: ['delete_preexisting_branch', 'delete_unmerged_branch'],
      },
    ]);
  });
  test('apply repeats PR evidence; reopened, none, empty, unknown and thrown errors all keep', async () => {
    const w = fixture();
    for (const answer of [
      [],
      [{ branch: 'feature', outcome: 'none' as const }],
      [{ branch: 'feature', outcome: 'unknown' as const, code: 'pulls_github_error' as const }],
      [{ ...w.merged, pull: { ...w.merged.pull, state: 'open' as const } }],
    ]) {
      w.setPulls(answer);
      expect((await w.service.remove(w.project.id, [w.tree.path])).removed).toEqual([]);
    }
    w.failPulls();
    expect((await w.service.remove(w.project.id, [w.tree.path])).removed).toEqual([]);
    expect(w.calls).toEqual([]);
  });
  test('local changes after display are kept, including published commits after merge', async () => {
    const w = fixture();
    expect((await w.service.list(w.project.id)).rows[0]?.verdict.removable).toBe(true);
    w.setRows([{ ...w.tree, live: { ...w.tree.live, head: 'b'.repeat(40), ahead: 0 } }]);
    expect((await w.service.remove(w.project.id, [w.tree.path])).removed).toEqual([]);
    expect(w.calls).toEqual([]);
  });
  test('caller folder is forwarded to core and refuses the caller checkout', async () => {
    const w = fixture();
    const result = await w.service.remove(w.project.id, [w.tree.path], w.tree.path);
    expect(result.skipped).toEqual([{ path: w.tree.path, reason: 'caller is here' }]);
    expect(w.calls).toEqual([]);
  });
  test('bulk returns removed/skipped independently, deduplicates and never expands reviewed paths', async () => {
    const w = fixture();
    const other = { ...w.tree, path: '/synthetic/other' };
    w.setRows([w.tree, other]);
    const result = await w.service.remove(w.project.id, ['/synthetic/missing', w.tree.path, w.tree.path]);
    expect(result.removed.map(row => row.path)).toEqual([w.tree.path]);
    expect(result.skipped.map(row => row.path)).toEqual(['/synthetic/missing']);
    expect((await w.service.list(w.project.id)).rows.map(row => row.worktree.path)).toEqual([other.path]);
  });
});
