import {
  ApiError,
  type CallContext,
  decodeParameter,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { ProjectIdSchema, type ProjectsApi } from '@ferretry/plugin-projects/contract';
import { PULLS_CODES, ReviewThreadsAnswerSchema } from '../../../contract/index.ts';
import { parseRepoSegment } from '../../../contract/repo-segment.ts';
import type { GithubClient } from '../../adapters/github/client.ts';
import { accountFor, readThreads } from './service.ts';

export interface ThreadsServices {
  readonly github: Pick<GithubClient, 'graphql'>;
  readonly projects: Pick<ProjectsApi, 'find'>;
  readonly nowIso: () => string;
}

const bad = (what: string) => new ApiError(400, `the ${what} in the path is not usable`, PULLS_CODES.refused);

/**
 * `GET /v1/pulls/:project/:repo/:number/threads`: every review thread of one PR. `:repo` is `owner~name`. The repository
 * must be one the project lists, read with that repository's account (else the project's first).
 */
export const threadsRoute =
  (services: ThreadsServices): RouteHandler =>
  async (call: CallContext) => {
    const project = ProjectIdSchema.safeParse(decodeParameter(call.params.get('project') ?? ''));
    if (!project.success) throw bad('project');
    const repo = parseRepoSegment(decodeParameter(call.params.get('repo') ?? '') ?? '');
    if (repo === undefined) throw bad('repository');
    const raw = decodeParameter(call.params.get('number') ?? '') ?? '';
    const number = /^[1-9][0-9]{0,9}$/u.test(raw) ? Number(raw) : 0;
    if (number === 0 || number > 2_147_483_647) throw bad('pull request number');

    const found = await services.projects.find(project.data);
    if (found === undefined) throw new ApiError(404, 'no such project', PULLS_CODES.notFound);
    const account = accountFor(found, repo);
    if (!account.ok) throw new ApiError(account.error.status, account.error.message, account.error.code);

    const read = await readThreads(services.github, account.value, repo, number, services.nowIso);
    if (!read.ok) throw new ApiError(read.error.status, read.error.message, read.error.code);
    return jsonResponse(ReviewThreadsAnswerSchema.parse(read.value));
  };
