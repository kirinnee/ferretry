import { ApiError, decodeParameter, jsonResponse, queryValues, type RouteHandler } from '@ferretry/kernel/contract';
import { ProjectIdSchema, type ProjectsApi } from '@ferretry/plugin-projects/contract';
import {
  BranchPullsAnswerSchema,
  isUsableBranch,
  MAX_BRANCH_PULLS,
  PULLS_CODES,
  type PullsApi,
} from '../../../contract/index.ts';
import { parseRepoSegment } from '../../../contract/repo-segment.ts';
import type { GithubClient } from '../../adapters/github/client.ts';
import { resolveRepo } from '../detail/resolve.ts';
import { readBranchPulls } from './service.ts';

export interface BranchesDeps {
  readonly github: Pick<GithubClient, 'get'>;
  readonly projects: Pick<ProjectsApi, 'find'>;
  readonly nowMs: () => number;
}

/** `GET /v1/pulls/:project/:repo/branches?branch=<name>` (repeat `branch`): the latest PR of each branch, any state. */
export const branchesRoutes = (
  deps: BranchesDeps,
): Readonly<Record<'GET /v1/pulls/:project/:repo/branches', RouteHandler>> => ({
  'GET /v1/pulls/:project/:repo/branches': async call => {
    for (const name of call.request.query.keys())
      if (name !== 'branch') throw new ApiError(400, `unknown parameter ${name}`, 'unknown_parameter');
    const project = ProjectIdSchema.safeParse(decodeParameter(call.params.get('project') ?? ''));
    if (!project.success) throw new ApiError(400, 'the project id in the path is not usable', 'invalid_project_id');
    const repo = parseRepoSegment(decodeParameter(call.params.get('repo') ?? '') ?? '');
    if (repo === undefined)
      throw new ApiError(400, 'the repository in the path is not owner~name', 'invalid_repository');
    const branches = queryValues(call.request, 'branch');
    if (branches.length === 0 || branches.length > MAX_BRANCH_PULLS)
      throw new ApiError(400, `name between 1 and ${MAX_BRANCH_PULLS} branches`, 'invalid_request');
    if (!branches.every(isUsableBranch))
      throw new ApiError(400, 'a branch is not a usable branch name', 'invalid_request');

    const resolved = await resolveRepo(deps.projects, project.data, repo);
    if (!resolved.ok) {
      const { kind, message } = resolved.failure;
      throw new ApiError(
        kind === 'account' ? 409 : 404,
        message,
        kind === 'account' ? PULLS_CODES.noAccount : PULLS_CODES.notFound,
      );
    }
    const results = await readBranchPulls(
      deps.github,
      { project: resolved.project.id, account: resolved.account, repo: resolved.repo },
      branches,
    );
    return jsonResponse(
      BranchPullsAnswerSchema.parse({
        repo: resolved.repo,
        branches: results,
        fetchedAt: new Date(deps.nowMs()).toISOString(),
      }),
    );
  },
});

/** The same read for another plugin (Tidy): a project, repository or account that cannot be resolved is all `unknown`. */
export const branchPullsPort = (deps: BranchesDeps): PullsApi => ({
  branchPulls: async (projectId, repo, branches) => {
    const resolved = await resolveRepo(deps.projects, projectId, repo);
    if (!resolved.ok) {
      const code = resolved.failure.kind === 'account' ? PULLS_CODES.noAccount : PULLS_CODES.notFound;
      return [...new Set(branches)].map(branch => ({
        branch: branch.slice(0, 255),
        outcome: 'unknown' as const,
        code,
      }));
    }
    return await readBranchPulls(
      deps.github,
      { project: resolved.project.id, account: resolved.account, repo: resolved.repo },
      branches,
    );
  },
});
