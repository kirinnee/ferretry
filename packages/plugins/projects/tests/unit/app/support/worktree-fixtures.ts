/** Synthetic answers of Ferrets' repository worktree list (`GET /v1/worktrees/repo`) for a two-repository project. */
import type { RepoWorktreeListResponse, RepoWorktreeRow } from '@ferretry/core-ferrets/contract';

export const LIST = 'GET /v1/worktrees/repo';
export const ADOPT = 'POST /v1/worktrees/adopt';

const clean = {
  staged: false,
  unstaged: false,
  untracked: false,
  ignored: false,
  conflicted: false,
  dirtySubmodule: false,
  truncated: false,
};

export const row = (
  path: string,
  branch: string,
  extra: Partial<Omit<RepoWorktreeRow, 'path' | 'live'>> & { live?: Partial<RepoWorktreeRow['live']> } = {},
): RepoWorktreeRow => {
  const { live, ...rest } = extra;
  return {
    path,
    main: false,
    bare: false,
    tracked: 'managed',
    live: { branch, detached: false, status: clean, undetermined: [], ...live },
    ...rest,
  };
};

/** The two repositories of the fixture project, as `<project>/<repo>/.git` names their common directories. */
export const ANSWERS: Readonly<Record<string, readonly RepoWorktreeRow[]>> = {
  '/work/ferretry/site/.git': [
    row('/work/ferretry/site', 'main', { main: true, tracked: 'none' }),
    row('/work/trees/site-nav', 'feat/nav', { live: { ahead: 2, status: { ...clean, unstaged: true } } }),
  ],
  '/work/ferretry/docs/.git': [
    row('/work/ferretry/docs', 'trunk', { main: true, tracked: 'none' }),
    row('/home/fake/old-docs-checkout', 'docs/old-fix', { tracked: 'none', live: { behind: 5 } }),
  ],
};

export const listAnswer = (commonDir: string, rows: readonly RepoWorktreeRow[]): RepoWorktreeListResponse => ({
  commonDirectory: commonDir,
  worktrees: [...rows],
  total: rows.length,
  truncated: false,
});
