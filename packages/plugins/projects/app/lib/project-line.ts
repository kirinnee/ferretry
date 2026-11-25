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

/** A deep folder as its last two names (`…/parent/name`): enough to tell like-named ones apart, none of the prefix. */
const shortPath = (path: string): string => {
  const names = path.split('/').filter(Boolean);
  return names.length > 2 ? `…/${names.slice(-2).join('/')}` : path;
};

/**
 * The one line under a project's name where a person picks it: its repository (`owner/name`, plus how many more), else
 * the folder's last two names. A folder with no repository has nothing else to say, and its parent is what tells two
 * like-named ones apart; the full path is the line's tooltip and stays searchable.
 */
export const projectLine = (project: ProjectInfo): string => {
  const repos = (project.repos ?? []).filter(repo => repo.remote !== undefined);
  const first = repos.at(0)?.remote;
  if (first === undefined) return shortPath(project.path);
  return repos.length > 1 ? `${remoteName(first)} + ${repos.length - 1} more` : remoteName(first);
};
