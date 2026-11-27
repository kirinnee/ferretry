/**
 * The app's half of "a project's branches and worktrees": it asks Ferrets' own repository worktree list (Ferrets owns what
 * Git says; Projects only names which repositories to ask about) and, for a checkout Ferretry does not track, sends the
 * existing in-place adoption. Both answers are parsed with Ferrets' contract; nothing here guesses a default.
 */
import {
  AdoptWorktreeRequestSchema,
  type RepoWorktreeListResponse,
  RepoWorktreeListResponseSchema,
  MoveProjectWorktreeRequestSchema,
  MovedProjectWorktreeSchema,
  type WorktreeMoveOffer,
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
  /**
   * Set for the project's OWN repository: it is asked about by the project's id, and the daemon answers from the directory
   * registration recorded (it takes no path for it, and refuses one it does not know). The repositories found inside the
   * folder have no id of their own and are asked about by their `.git` folder.
   */
  readonly project?: string;
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
  if (project.git !== undefined)
    add({ name: baseName(root), folder: root, commonDir: project.git.commonDirectory, project: project.id });
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

export const readRepoWorktrees = async (
  client: ProjectsClient,
  source: WorktreeSource,
  project?: string,
): Promise<RepoWorktreeListResponse> =>
  RepoWorktreeListResponseSchema.parse(
    await client.call(LIST_ROUTE, {
      query:
        source.project === undefined
          ? { commonDir: source.commonDir, ...(project === undefined ? {} : { moveProject: project }) }
          : { project: source.project },
    }),
  );

/** Takes the checkout over where it stands: Ferrets never moves it. */
export const adoptWorktree = async (client: ProjectsClient, path: string): Promise<void> => {
  await client.call(ADOPT_ROUTE, { body: AdoptWorktreeRequestSchema.parse({ path }) });
};

export const moveWorktree = async (
  client: ProjectsClient,
  project: string,
  offer: WorktreeMoveOffer,
): Promise<void> => {
  MovedProjectWorktreeSchema.parse(
    await client.call('POST /v1/worktrees/move', {
      body: MoveProjectWorktreeRequestSchema.parse({
        project,
        worktreeId: offer.worktreeId,
        reviewedIdentity: offer.reviewedIdentity,
      }),
    }),
  );
};
