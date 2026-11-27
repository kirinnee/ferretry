/** The app's half of "clone another repository into this project": the contract parses the request and the answer. */
import { CloneRepoRequestSchema, type ProjectReposAnswer, ProjectReposAnswerSchema } from '../../../contract/index.ts';
import type { ProjectsClient } from '../../lib/client.ts';

const CLONE_ROUTE = 'POST /v1/projects/:id/repos';

/** Clones `url` into the project's folder on exactly the paired daemon; answers the repositories the project now holds. */
export const cloneRepo = async (client: ProjectsClient, projectId: string, url: string): Promise<ProjectReposAnswer> =>
  ProjectReposAnswerSchema.parse(
    await client.call(CLONE_ROUTE, { params: { id: projectId }, body: CloneRepoRequestSchema.parse({ url }) }),
  );
