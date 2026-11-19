import { ApiError, decodeParameter, jsonResponse, queryValue, type RouteHandler } from '@ferretry/kernel/contract';
import type { GitAccountsApi } from '@ferretry/plugin-git-accounts/contract';
import { type ProjectsApi, ProjectIdSchema } from '@ferretry/plugin-projects/contract';
import { PULLS_CODES } from '../../../contract/index.ts';
import type { ReadFailure } from '../../adapters/github/client.ts';
import type { CiReader, CiScope } from './reader.ts';
import { resolveTarget, type TargetFailure } from './target.ts';

export interface CiRouteDeps {
  readonly reader: CiReader;
  readonly projects: Pick<ProjectsApi, 'find'>;
  readonly accounts: Pick<GitAccountsApi, 'list'>;
}

/** GitHub's own bounds on a branch name and a run's attempts. */
const MAX_BRANCH = 255;
const MAX_ATTEMPT = 1000;

const refuse = (failure: TargetFailure): never => {
  throw new ApiError(failure.status, failure.message, failure.code);
};

/** A read that did not answer, as the daemon's own words. A pause says until when, so every screen can say it once. */
function failWith(failure: ReadFailure): never {
  switch (failure.code) {
    case PULLS_CODES.paused:
      throw new ApiError(
        503,
        'polling is paused to stay inside GitHub’s limit',
        PULLS_CODES.paused,
        undefined,
        failure.pausedUntilMs === undefined
          ? undefined
          : { pausedUntil: new Date(failure.pausedUntilMs).toISOString() },
      );
    case PULLS_CODES.notFound:
      throw new ApiError(404, failure.message, PULLS_CODES.notFound);
    case PULLS_CODES.denied:
      throw new ApiError(502, failure.message, PULLS_CODES.denied);
    case PULLS_CODES.refused:
      throw new ApiError(409, failure.message, PULLS_CODES.refused);
    default:
      throw new ApiError(502, failure.message, PULLS_CODES.github);
  }
}

const positiveInt = (raw: string, what: string, max = Number.MAX_SAFE_INTEGER): number => {
  const value = /^[0-9]{1,15}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new ApiError(400, `${what} is a positive whole number`, 'invalid_request');
  return value;
};

/** The repository, its account (which must still exist) and the cache it is kept in. Refuses with our words. */
async function scopeOf(deps: CiRouteDeps, params: { get(name: string): string | undefined }): Promise<CiScope> {
  const id = ProjectIdSchema.safeParse(decodeParameter(params.get('project') ?? ''));
  if (!id.success) throw new ApiError(400, 'the project id in the path is not usable', 'invalid_request');
  const found = resolveTarget(await deps.projects.find(id.data), decodeParameter(params.get('repo') ?? '') ?? '');
  if (!found.ok) return refuse(found.error);
  const accounts = await deps.accounts.list();
  if (!accounts.some(account => account.id === found.value.account))
    throw new ApiError(409, 'the GitHub account linked to this project is gone', PULLS_CODES.noAccount);
  return { project: id.data, account: found.value.account, repo: found.value.repo };
}

const onlyParameters = (request: { query: ReadonlyMap<string, unknown> }, allowed: readonly string[]): void => {
  for (const name of request.query.keys())
    if (!allowed.includes(name)) throw new ApiError(400, `unknown parameter ${name}`, 'unknown_parameter');
};

/**
 * `GET /v1/pulls/:project/:repo/runs?pr=<n>|branch=<name>`: every run of that pull request's (or branch's) head commit,
 * newest first, as `CiRun[]`: GitHub Actions runs with their jobs and steps, then each other CI as one bar.
 */
export const runsRoute =
  (deps: CiRouteDeps): RouteHandler =>
  async call => {
    onlyParameters(call.request, ['pr', 'branch']);
    const pr = queryValue(call.request, 'pr');
    const branch = queryValue(call.request, 'branch');
    if ((pr === undefined) === (branch === undefined))
      throw new ApiError(400, 'name exactly one of pr and branch', 'invalid_request');
    if (branch !== undefined && (branch.length > MAX_BRANCH || /[\p{Cc}\s]/u.test(branch)))
      throw new ApiError(400, 'branch is not a usable branch name', 'invalid_request');
    const scope = await scopeOf(deps, call.params);
    const head = await deps.reader.headSha(
      scope,
      pr === undefined ? { branch: branch as string } : { pr: positiveInt(pr, 'pr') },
    );
    if (!head.ok) return failWith(head.error);
    const runs = await deps.reader.runs(scope, head.value);
    return runs.ok ? jsonResponse(runs.value) : failWith(runs.error);
  };

/** `GET /v1/pulls/:project/:repo/runs/:runId[?attempt=<n>]`: one Actions run with its jobs, steps and timing. */
export const runRoute =
  (deps: CiRouteDeps): RouteHandler =>
  async call => {
    onlyParameters(call.request, ['attempt']);
    const runId = positiveInt(decodeParameter(call.params.get('runId') ?? '') ?? '', 'the run id');
    const attempt = queryValue(call.request, 'attempt');
    const wanted = attempt === undefined ? undefined : positiveInt(attempt, 'attempt', MAX_ATTEMPT);
    const scope = await scopeOf(deps, call.params);
    const run = await deps.reader.run(scope, runId, wanted);
    return run.ok ? jsonResponse(run.value) : failWith(run.error);
  };
