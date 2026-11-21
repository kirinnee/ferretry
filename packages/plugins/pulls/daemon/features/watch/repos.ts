import type { GitAccount } from '@ferretry/plugin-git-accounts/contract';
import type { ProjectInfo, ProjectRepo } from '@ferretry/plugin-projects/contract';
import { RepoRefSchema, type RepoRef } from '../../../contract/index.ts';

const GITHUB_REMOTE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u;

/** The GitHub repository a project's repo points at, or `undefined` (another host, no remote, an odd name). */
export function repoRefOf(repo: ProjectRepo): RepoRef | undefined {
  if (repo.provider !== 'github' || repo.remote === undefined) return undefined;
  const match = GITHUB_REMOTE.exec(repo.remote);
  if (match === null) return undefined;
  const parsed = RepoRefSchema.safeParse({ provider: 'github', owner: match[1], name: match[2] });
  return parsed.success ? parsed.data : undefined;
}

export interface WatchedRepoRef {
  readonly repo: RepoRef;
  /** The account to read it as, or `undefined` when none is linked or the linked one is gone. */
  readonly account: GitAccount | undefined;
}

/**
 * Whether a project has a GitHub reader: some repository of it reads as an account, or the project names an account that
 * still exists. This is what turns a watch on by itself (r11 S7); with none, nothing is ever asked of GitHub for it.
 */
export function hasReader(project: ProjectInfo, accounts: readonly GitAccount[]): boolean {
  if (reposOf(project, accounts).some(ref => ref.account !== undefined)) return true;
  return (project.accounts ?? []).some(id => accounts.some(account => account.id === id));
}

/**
 * Each GitHub repository of a project (one per remote), with the account that reads it: the repository's own link, else
 * the project's first account. A link to an account that no longer exists reads as no account, never as a guess.
 * (B4 owns the general folder → account rule; until it lands this is the same two-step choice, in one place.)
 */
export function reposOf(project: ProjectInfo, accounts: readonly GitAccount[]): readonly WatchedRepoRef[] {
  const seen = new Set<string>();
  const out: WatchedRepoRef[] = [];
  for (const repo of project.repos ?? []) {
    const ref = repoRefOf(repo);
    if (ref === undefined) continue;
    const key = `${ref.owner}/${ref.name}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const id = repo.account ?? project.accounts?.[0];
    out.push({ repo: ref, account: accounts.find(account => account.id === id) });
  }
  return out;
}
