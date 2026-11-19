import type { GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import { err, ok, type Result } from '@ferretry/std';
import { PULLS_CODES, type PullsCode, type RepoRef } from '../../../contract/index.ts';
import { parseRepoSegment } from '../../../contract/repo-segment.ts';

/** Why a request names no repository we can read. Ours, never GitHub's. */
export interface TargetFailure {
  readonly status: number;
  readonly code: PullsCode | 'invalid_request';
  readonly message: string;
}

/** The repository a route addresses, and the account that reads it. */
export interface Target {
  readonly repo: RepoRef;
  readonly account: GitAccountId;
}

/** `owner`/`name` of a GitHub remote written as `https://github.com/<owner>/<name>[.git]`, or `undefined`. */
function githubRemote(remote: string | undefined): { owner: string; name: string } | undefined {
  if (remote === undefined || !URL.canParse(remote)) return undefined;
  const url = new URL(remote);
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return undefined;
  const [owner, name, ...rest] = url.pathname.split('/').filter(part => part !== '');
  if (owner === undefined || name === undefined || rest.length > 0) return undefined;
  return { owner, name: name.replace(/\.git$/u, '') };
}

/**
 * The repository of a project that matches `owner~name`, with the account that reads it: the repository's own account,
 * else the project's first one (`ProjectRepo.account`, `ProjectInfo.accounts`). The repository must be one the project
 * lists: a request cannot reach a repository the project does not hold.
 */
export function resolveTarget(project: ProjectInfo | undefined, repoParam: string): Result<Target, TargetFailure> {
  const wanted = parseRepoSegment(repoParam);
  if (wanted === undefined)
    return err({ status: 400, code: 'invalid_request', message: 'the repository in the path is not owner~name' });
  if (project === undefined)
    return err({ status: 404, code: PULLS_CODES.notFound, message: 'there is no such project' });
  const match = (project.repos ?? []).find(repo => {
    const remote = githubRemote(repo.remote);
    return (
      remote !== undefined &&
      remote.owner.toLowerCase() === wanted.owner.toLowerCase() &&
      remote.name.toLowerCase() === wanted.name.toLowerCase()
    );
  });
  if (match === undefined)
    return err({
      status: 404,
      code: PULLS_CODES.notFound,
      message: 'that repository is not one this project lists on GitHub',
    });
  const account = match.account ?? project.accounts?.[0];
  if (account === undefined)
    return err({ status: 409, code: PULLS_CODES.noAccount, message: 'no GitHub account is linked to this project' });
  return ok({ repo: { provider: 'github', owner: wanted.owner, name: wanted.name }, account: account as GitAccountId });
}
