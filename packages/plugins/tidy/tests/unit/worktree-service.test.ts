import { describe, expect, test } from 'bun:test';
import type { RepoWorktreeRow, GuardedWorktreeRemovalRequest } from '@ferretry/core-ferrets/contract';
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
  const identity = { recordId: 'row', branchRef: 'refs/heads/feature', checkout: '1:2', head };
  const reviewed = (path: string) => ({ path, identity });
  const calls: GuardedWorktreeRemovalRequest[] = [];
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
        reviewedIdentity: identity,
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
    reviewed,
    identity,
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
  test('read-only verdict delegates safety, and apply sends only the reviewed identity and required head', async () => {
    const w = fixture();
    expect((await w.service.list(w.project.id)).rows[0]?.verdict.removable).toBe(true);
    expect(w.calls).toEqual([]);
    const applied = await w.service.remove(w.project.id, [w.reviewed(w.tree.path)]);
    expect(applied.removed).toHaveLength(1);
    expect(w.calls).toEqual([
      {
        path: w.tree.path,
        expectedHead: w.identity.head,
        expectedIdentity: w.identity,
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
      expect((await w.service.remove(w.project.id, [w.reviewed(w.tree.path)])).removed).toEqual([]);
    }
    w.failPulls();
    expect((await w.service.remove(w.project.id, [w.reviewed(w.tree.path)])).removed).toEqual([]);
    expect(w.calls).toEqual([]);
  });
  test('local changes after display are kept, including published commits after merge', async () => {
    const w = fixture();
    expect((await w.service.list(w.project.id)).rows[0]?.verdict.removable).toBe(true);
    w.setRows([{ ...w.tree, live: { ...w.tree.live, head: 'b'.repeat(40), ahead: 0 } }]);
    expect((await w.service.remove(w.project.id, [w.reviewed(w.tree.path)])).removed).toEqual([]);
    expect(w.calls).toEqual([]);
  });
  test('caller folder is forwarded to core and refuses the caller checkout', async () => {
    const w = fixture();
    const result = await w.service.remove(w.project.id, [w.reviewed(w.tree.path)], w.tree.path);
    expect(result.skipped).toEqual([{ path: w.tree.path, reason: 'caller is here' }]);
    expect(w.calls).toEqual([]);
  });
  test('bulk returns removed/skipped independently, deduplicates and never expands reviewed paths', async () => {
    const w = fixture();
    const other = { ...w.tree, path: '/synthetic/other' };
    w.setRows([w.tree, other]);
    const result = await w.service.remove(
      w.project.id,
      ['/synthetic/missing', w.tree.path, w.tree.path].map(w.reviewed),
    );
    expect(result.removed.map(row => row.path)).toEqual([w.tree.path]);
    expect(result.skipped.map(row => row.path)).toEqual(['/synthetic/missing']);
    expect((await w.service.list(w.project.id)).rows.map(row => row.worktree.path)).toEqual([other.path]);
  });

  test('a different reviewed record, branch, directory or head is kept even at the same path', async () => {
    for (const change of [
      { recordId: 'replacement' },
      { branchRef: 'refs/heads/unrelated' },
      { checkout: '1:3' },
      { head: 'b'.repeat(40) },
    ]) {
      const w = fixture();
      const result = await w.service.remove(w.project.id, [
        { path: w.tree.path, identity: { ...w.identity, ...change } },
      ]);
      expect(result.removed).toEqual([]);
      expect(result.skipped[0]?.reason).toContain('reviewed worktree changed');
      expect(w.calls).toEqual([]);
    }
  });

  test('unavailable removal, thrown safety evidence and a failed core mutation each keep the row', async () => {
    const w = fixture();
    const common = {
      repoWorktrees: async () => ({
        commonDirectory: '/synthetic/repo/.git',
        worktrees: [w.tree],
        total: 1,
        truncated: false,
      }),
      checkWorktreeRemoval: async () => ({
        path: w.tree.path,
        branch: 'feature',
        head: w.identity.head,
        removable: true,
        blockers: [],
        reviewedIdentity: w.identity,
      }),
    };
    for (const ferrets of [
      common,
      {
        ...common,
        checkWorktreeRemoval: async () => {
          throw new Error('cannot inspect');
        },
      },
      {
        ...common,
        removeWorktree: async () => {
          throw new Error('changed at core boundary');
        },
      },
    ]) {
      const service = new TidyWorktreesService({
        ferrets,
        projects: () => ({ find: async () => w.project }),
        pulls: () => ({ branchPulls: async () => [w.merged] }),
      });
      const result = await service.remove(w.project.id, [w.reviewed(w.tree.path)]);
      expect(result.removed).toEqual([]);
      expect(result.skipped).toHaveLength(1);
    }
  });

  test('registering the main Git repository without a repos entry still lists it once', async () => {
    const w = fixture();
    const service = new TidyWorktreesService({
      projects: () => ({ find: async () => ({ ...w.project, repos: undefined }) }),
      pulls: () => undefined,
      ferrets: {
        repoWorktrees: async commonDirectory => ({ commonDirectory, worktrees: [w.tree], total: 1, truncated: true }),
      },
    });
    const result = await service.list(w.project.id);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.verdict.removable).toBe(false);
    expect(result.truncated).toBe(true);
  });

  test('the row budget stops a repository that returns too many rows', async () => {
    const w = fixture();
    const service = new TidyWorktreesService({
      projects: () => ({ find: async () => w.project }),
      pulls: () => undefined,
      ferrets: {
        repoWorktrees: async commonDirectory => ({
          commonDirectory,
          worktrees: Array.from({ length: 501 }, () => w.tree),
          total: 501,
          truncated: false,
        }),
      },
    });
    const result = await service.list(w.project.id);
    expect(result.rows).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  test('an unreadable saved nested repository is reported at its own common directory', async () => {
    const w = fixture();
    const service = new TidyWorktreesService({
      projects: () => ({ find: async () => ({ ...w.project, git: undefined, repos: [{ path: 'nested' }] }) }),
      pulls: () => undefined,
      ferrets: {
        repoWorktrees: async directory => {
          expect(directory).toBe('/synthetic/repo/nested/.git');
          throw new Error('authorized Git could not read this repository');
        },
      },
    });
    const result = await service.list(w.project.id);
    expect(result.rows).toEqual([]);
    expect(result.unavailable).toEqual([
      { commonDirectory: '/synthetic/repo/nested/.git', reason: 'This repository could not be read safely' },
    ]);
  });
});
