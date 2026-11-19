import type { ProjectInfo, ProjectsApi } from '@ferretry/plugin-projects/contract';
import type { GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import type { RepoRef } from '../../../contract/index.ts';

/** Why a repository could not be matched to a project and an account. `message` is ours. */
interface ResolveFailure {
  readonly kind: 'project' | 'repo' | 'account';
  readonly message: string;
}

export type Resolved =
  | { readonly ok: true; readonly project: ProjectInfo; readonly repo: RepoRef; readonly account: GitAccountId }
  | { readonly ok: false; readonly failure: ResolveFailure };

/** `https://github.com/<owner>/<name>` (what Projects keeps as a repository's `remote`) as an owner and a name. */
const GITHUB_REMOTE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/iu;

/**
 * The account that reads one repository of one project: the account linked to that repository, else the project's first
 * (the default), the order Projects keeps (B5). The repository must be one this project holds: a project id never reaches
 * a repository its folder does not contain. B4 adds a resolver from a folder to an account; until it lands this is the same
 * rule over the project's own record.
 */
export async function resolveRepo(
  projects: Pick<ProjectsApi, 'find'>,
  projectId: string,
  repo: Pick<RepoRef, 'owner' | 'name'>,
): Promise<Resolved> {
  const project = await projects.find(projectId as never);
  if (project === undefined)
    return { ok: false, failure: { kind: 'project', message: 'Ferretry has no project with that id' } };
  const held = (project.repos ?? []).find(candidate => {
    const match = GITHUB_REMOTE.exec(candidate.remote ?? '');
    return (
      match?.[1]?.toLowerCase() === repo.owner.toLowerCase() && match[2]?.toLowerCase() === repo.name.toLowerCase()
    );
  });
  if (held === undefined)
    return {
      ok: false,
      failure: { kind: 'repo', message: 'that repository is not one of this project’s repositories' },
    };
  const account = held.account ?? project.accounts?.[0];
  if (account === undefined)
    return {
      ok: false,
      failure: {
        kind: 'account',
        message: 'This project is not linked to a GitHub account. Link one in the project to see its PRs.',
      },
    };
  return {
    ok: true,
    project,
    repo: { provider: 'github', owner: repo.owner, name: repo.name },
    account: account as GitAccountId,
  };
}
