import type { ProjectInfo } from '../../contract/index.ts';

/** `https://github.com/owner/name` -> `owner/name`; anything else is shown as the host and path it names. */
const remoteName = (remote: string): string => {
  try {
    const url = new URL(remote);
    return `${url.host === 'github.com' ? '' : `${url.host}/`}${url.pathname.replace(/^\/+|\.git$|\/+$/gu, '')}`;
  } catch {
    return remote;
  }
};

/**
 * The one line under a project's name where a person picks it: its repository (`owner/name`, plus how many more), else
 * the folder. A folder with no repository has nothing else to say, and the path is what tells two like-named ones apart.
 */
export const projectLine = (project: ProjectInfo): string => {
  const repos = (project.repos ?? []).filter(repo => repo.remote !== undefined);
  const first = repos.at(0)?.remote;
  if (first === undefined) return project.path;
  return repos.length > 1 ? `${remoteName(first)} + ${repos.length - 1} more` : remoteName(first);
};
