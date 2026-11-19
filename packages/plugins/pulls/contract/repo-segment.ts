import { GITHUB_LOGIN, GITHUB_REPO_NAME, type RepoRef } from './wire.ts';

/**
 * A repository in ONE path segment: `owner~name`. `/` cannot ride in a path parameter (the kernel refuses a decoded one)
 * and `~` is in neither a GitHub login nor a repository name, so the split is unambiguous. Every E route that names a
 * repository (`/v1/pulls/:project/:repo/…`) uses it. Pure.
 */
export const repoSegment = (repo: Pick<RepoRef, 'owner' | 'name'>): string => `${repo.owner}~${repo.name}`;

export function parseRepoSegment(segment: string): Pick<RepoRef, 'owner' | 'name'> | undefined {
  const at = segment.indexOf('~');
  if (at < 1 || segment.indexOf('~', at + 1) !== -1) return undefined;
  const owner = segment.slice(0, at);
  const name = segment.slice(at + 1);
  if (!GITHUB_LOGIN.test(owner) || !GITHUB_REPO_NAME.test(name) || name === '.' || name === '..') return undefined;
  return { owner, name };
}
