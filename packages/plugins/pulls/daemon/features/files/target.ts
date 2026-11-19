import type { GitAccountId, GitAccountsApi } from '@ferretry/plugin-git-accounts/contract';
import type { ProjectsApi } from '@ferretry/plugin-projects/contract';
import { PULLS_CODES, type PullsCode, type RepoRef } from '../../../contract/index.ts';

/** The project's repository and the account that reads it, or why neither could be named. */
export type Target =
  | {
      readonly ok: true;
      readonly project: string;
      readonly repo: RepoRef;
      readonly account: GitAccountId;
      /** The account's GitHub login, read in the same list as the id (so the two can never disagree). */
      readonly login: string;
    }
  | { readonly ok: false; readonly status: 404 | 409; readonly code: PullsCode; readonly message: string };

const GITHUB_REMOTE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/iu;

const sameRepo = (remote: string | undefined, repo: RepoRef): boolean => {
  const match = remote === undefined ? null : GITHUB_REMOTE.exec(remote);
  return match?.[1]?.toLowerCase() === repo.owner.toLowerCase() && match[2]?.toLowerCase() === repo.name.toLowerCase();
};

/**
 * Which account reads a project's repository: the repository's own link, else the project's first account (B5 keeps
 * both). B4's folder→account resolver is the long-term owner of this choice; until it lands this is the same rule, read
 * from the same record, so swapping it in changes nothing a caller sees.
 *
 * Only a repository the project holds can be read: the path names a repository, and a request may not use a project's
 * account to read a repository the project does not have.
 */
export async function resolveTarget(
  ports: { readonly projects: Pick<ProjectsApi, 'find'>; readonly accounts: Pick<GitAccountsApi, 'list'> },
  projectId: string,
  repo: RepoRef,
): Promise<Target> {
  const project = await ports.projects.find(projectId as never);
  if (project === undefined) return { ok: false, status: 404, code: PULLS_CODES.notFound, message: 'no such project' };
  const held = project.repos?.find(candidate => candidate.provider === 'github' && sameRepo(candidate.remote, repo));
  if (held === undefined)
    return {
      ok: false,
      status: 404,
      code: PULLS_CODES.notFound,
      message: 'this project does not hold that repository',
    };
  const wanted = held.account ?? project.accounts?.[0];
  if (wanted === undefined)
    return {
      ok: false,
      status: 409,
      code: PULLS_CODES.noAccount,
      message: 'link a GitHub account to this project first',
    };
  const account = (await ports.accounts.list()).find(candidate => candidate.id === wanted);
  if (account === undefined)
    return {
      ok: false,
      status: 409,
      code: PULLS_CODES.noAccount,
      message: 'the GitHub account linked to this project was removed',
    };
  return { ok: true, project: project.id, repo, account: account.id, login: account.login };
}
