import { ApiError, decodeParameter, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import { ProjectIdSchema, SetProjectAccountsRequestSchema } from '../../../contract/index.ts';
import { parseBody } from '../../lib/body.ts';
import type { ProjectRegistry } from '../../lib/registry.ts';
import { type ScanDeps, scanRepos } from './scan.ts';

const projectId = (raw: string | undefined) => {
  const id = ProjectIdSchema.safeParse(decodeParameter(raw ?? ''));
  if (!id.success) throw new ApiError(400, 'the project id in the path is not usable', 'invalid_project_id');
  return id.data;
};

/**
 * `GET /v1/projects/:id/repos`: scans the project folder now and answers (and keeps) what it found. A scan that did not
 * see everything (`truncated`: a bound, a refused or missing folder, an unreadable one) only ADDS what it found: a stored
 * repository it did not see, and the account linked to it, stay.
 */
export const reposRoute =
  (registry: ProjectRegistry, scan: ScanDeps): RouteHandler =>
  async call => {
    const id = projectId(call.params.get('id'));
    const project = await registry.find(id);
    if (project === undefined) throw new ApiError(404, `no project ${id}`, 'not-found');
    const result = await scanRepos(project.path, scan);
    const kept = await registry.recordRepos(id, result.repos, !result.truncated);
    if (!kept.ok) throw new ApiError(404, kept.error.message, 'not-found');
    return jsonResponse({ repos: kept.value.repos ?? [], truncated: result.truncated });
  };

/** `PUT /v1/projects/:id/accounts` `{accounts}`: the whole list, in order. Answers the project. */
export const accountsRoute =
  (registry: ProjectRegistry): RouteHandler =>
  async call => {
    const id = projectId(call.params.get('id'));
    const body = await parseBody(call.request, SetProjectAccountsRequestSchema);
    const set = await registry.setAccounts(id, body.accounts);
    if (!set.ok) throw new ApiError(404, set.error.message, 'not-found');
    return jsonResponse(set.value);
  };
