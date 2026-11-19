/**
 * Which Git account a folder pushes and signs as: the ONE place that decides it (r9 B4). Folder, then the project that
 * holds it (the longest project path that is the folder or an ancestor of it), then:
 *
 * 1. the repository the folder is inside (the longest repository path), and that repository's own `account` when it
 *    names one;
 * 2. else the project's FIRST linked account.
 *
 * Never a substitution: a named account that no longer exists (a link outlives its account, B5) answers nothing, so a
 * push is not silently made as somebody else. Strings only: no disk is read, and a folder reached through a link is
 * judged by the spelling it was given.
 */
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import type { GitAccountId } from '../../contract/index.ts';

const plain = (path: string): string => (path.length > 1 ? path.replace(/\/+$/u, '') : path);
const holds = (root: string, folder: string): boolean =>
  root === '/' || folder === root || folder.startsWith(`${root}/`);

export interface FolderAccount {
  readonly account: GitAccountId;
  /** The project the folder is in. */
  readonly project: string;
  /** The repository the folder is inside, when the project records one (B9: where `gh` is pointed). */
  readonly repo?: NonNullable<ProjectInfo['repos']>[number];
}

export function accountForFolder(
  folderPath: string,
  projects: readonly ProjectInfo[],
  exists: (account: string) => boolean,
): FolderAccount | undefined {
  const folder = plain(folderPath);
  let project: ProjectInfo | undefined;
  for (const candidate of projects) {
    if (!holds(plain(candidate.path), folder)) continue;
    if (project === undefined || plain(candidate.path).length > plain(project.path).length) project = candidate;
  }
  if (project === undefined) return undefined;
  const root = plain(project.path);
  let repo: NonNullable<ProjectInfo['repos']>[number] | undefined;
  for (const candidate of project.repos ?? []) {
    const at = candidate.path === '.' ? root : `${root}/${candidate.path}`;
    if (!holds(at, folder)) continue;
    if (repo === undefined || candidate.path.length > repo.path.length) repo = candidate;
  }
  const named = repo?.account ?? project.accounts?.[0];
  if (named === undefined || !exists(named)) return undefined;
  return { account: named as GitAccountId, project: project.id, ...(repo === undefined ? {} : { repo }) };
}
