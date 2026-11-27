/**
 * The app's half of "a project's branches and worktrees": it asks Ferrets' own repository worktree list (Ferrets owns what
 * Git says; Projects only names which repositories to ask about) and, for a checkout Ferretry does not track, sends the
 * existing in-place adoption. Both answers are parsed with Ferrets' contract; nothing here guesses a default.
 */
import {
  AdoptWorktreeRequestSchema,
  type RepoWorktreeListResponse,
  RepoWorktreeListResponseSchema,
} from '@ferretry/core-ferrets/contract';
import type { ProjectInfo } from '../../../contract/index.ts';
import type { ProjectsClient } from '../../lib/client.ts';
import { baseName, normalizeProjectPath } from '../../lib/folders.ts';

const LIST_ROUTE = 'GET /v1/worktrees/repo';
const ADOPT_ROUTE = 'POST /v1/worktrees/adopt';

/** One repository to ask about: what to call it, where its checkout stands and its git common directory. */
export interface WorktreeSource {
  readonly name: string;
  readonly folder: string;
  readonly commonDir: string;
}

/**
 * Which repositories to ask Ferrets about, and for each its git COMMON directory (the one fact Ferrets' list is keyed by).
 *
 * The project's own repository comes from the common directory registration recorded (`git rev-parse
 * --path-format=absolute --git-common-dir`), never from the optional saved `repos` list: a project folder that is a main
 * checkout OR a linked one names the right directory either way, and one whose scan has not kept anything still has it.
 * Repositories found INSIDE the folder (`repos`, never the folder itself) can only be asked about by their own `.git`
 * folder; one that is a linked checkout (its marker is a file) is refused by Ferrets, and the page folds it into the
 * repository that lists it (see `project-worktrees.tsx`). Two sources never share a common directory.
 */
export const worktreeSources = (project: ProjectInfo): readonly WorktreeSource[] => {
  const root = normalizeProjectPath(project.path);
  const sources: WorktreeSource[] = [];
  const add = (source: WorktreeSource): void => {
    if (!sources.some(known => known.commonDir === source.commonDir)) sources.push(source);
  };
  const repos = project.repos ?? [];
  if (project.git !== undefined) add({ name: baseName(root), folder: root, commonDir: project.git.commonDirectory });
  for (const repo of repos) {
    if (repo.path === '.') {
      // The folder itself: its recorded common directory already stands above; only a record that has none falls back.
      if (project.git === undefined) add({ name: baseName(root), folder: root, commonDir: `${root}/.git` });
      continue;
    }
    const folder = `${root}/${repo.path}`;
    add({ name: repo.path, folder, commonDir: `${folder}/.git` });
  }
  return sources;
};

export const readRepoWorktrees = async (client: ProjectsClient, commonDir: string): Promise<RepoWorktreeListResponse> =>
  RepoWorktreeListResponseSchema.parse(await client.call(LIST_ROUTE, { query: { commonDir } }));

/** Takes the checkout over where it stands: Ferrets never moves it. */
export const adoptWorktree = async (client: ProjectsClient, path: string): Promise<void> => {
  await client.call(ADOPT_ROUTE, { body: AdoptWorktreeRequestSchema.parse({ path }) });
};
