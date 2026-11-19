import { ApiError, decodeParameter, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import type { ProjectsApi } from '@ferretry/plugin-projects/contract';
import { ProjectIdSchema } from '@ferretry/plugin-projects/contract';
import { PULLS_CODES, PullPageAnswerSchema, type PullsCode } from '../../../contract/index.ts';
import { parseRepoSegment } from '../../../contract/repo-segment.ts';
import type { GithubClient } from '../../adapters/github/client.ts';
import { readPullPage } from './read.ts';
import { resolveRepo } from './resolve.ts';

export interface DetailDeps {
  readonly github: GithubClient;
  readonly projects: Pick<ProjectsApi, 'find'>;
}

const STATUS: Readonly<Record<PullsCode, number>> = {
  [PULLS_CODES.paused]: 429,
  [PULLS_CODES.noAccount]: 409,
  [PULLS_CODES.notFound]: 404,
  [PULLS_CODES.denied]: 403,
  [PULLS_CODES.github]: 502,
  [PULLS_CODES.refused]: 502,
};

/**
 * `GET /v1/pulls/:project/:repo/:number` (`:repo` is `owner~name`): one pull request, its conversation (comments and
 * reviews) and its head commit's checks. The account is the one linked to that repository (or its project). The body is
 * the wire shape alone: GitHub's `body_html` and avatar addresses never reach it.
 */
export const detailRoute =
  (deps: DetailDeps): RouteHandler =>
  async call => {
    const project = ProjectIdSchema.safeParse(decodeParameter(call.params.get('project') ?? ''));
    if (!project.success) throw new ApiError(400, 'the project id in the path is not usable', 'invalid_project_id');
    const repo = parseRepoSegment(decodeParameter(call.params.get('repo') ?? '') ?? '');
    if (repo === undefined)
      throw new ApiError(400, 'the repository in the path is not owner~name', 'invalid_repository');
    const rawNumber = decodeParameter(call.params.get('number') ?? '') ?? '';
    const number = /^[1-9][0-9]{0,8}$/u.test(rawNumber) ? Number(rawNumber) : 0;
    if (number === 0) throw new ApiError(400, 'the pull request number in the path is not usable', 'invalid_number');

    const resolved = await resolveRepo(deps.projects, project.data, repo);
    if (!resolved.ok) {
      const { kind, message } = resolved.failure;
      if (kind === 'account') throw new ApiError(409, message, PULLS_CODES.noAccount);
      throw new ApiError(404, message, PULLS_CODES.notFound);
    }

    const answer = await readPullPage(deps.github, {
      project: resolved.project.id,
      account: resolved.account,
      repo: resolved.repo,
      number,
    });
    if (!answer.ok) throw new ApiError(STATUS[answer.error.code], answer.error.message, answer.error.code);
    return jsonResponse(PullPageAnswerSchema.parse(answer.value));
  };
