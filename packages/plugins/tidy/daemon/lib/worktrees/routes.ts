import {
  ApiError,
  decodeParameter,
  jsonResponse,
  type CallContext,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { ferretOf } from '@ferretry/core-gate/contract';
import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import { ProjectIdSchema } from '@ferretry/plugin-projects/contract';
import {
  TidyWorktreeRemoveRequestSchema,
  TidyWorktreeRemoveResultSchema,
  TidyWorktreesSchema,
} from '../../../contract/index.ts';
import type { TidyWorktreesService } from './service.ts';

export function worktreeRoutes(service: TidyWorktreesService, ferrets: Pick<FerretsApi, 'get'>) {
  const project = (call: CallContext) => {
    const parsed = ProjectIdSchema.safeParse(decodeParameter(call.params.get('project') ?? ''));
    if (!parsed.success) throw new ApiError(400, 'A registered project id is required', 'invalid_project_id');
    return parsed.data;
  };
  const callerCwd = async (call: CallContext, declared?: string) => {
    const own = ferretOf(call);
    if (own === undefined) return declared;
    const ferret = await ferrets.get(own);
    if (ferret === undefined) throw new ApiError(503, 'The caller folder could not be determined', 'unavailable');
    return ferret.folder;
  };
  const remove: RouteHandler = async call => {
    const id = project(call);
    let raw: unknown;
    try {
      raw = JSON.parse(await call.request.text(64 * 1024));
    } catch {
      throw new ApiError(400, 'The request body is not JSON', 'invalid_json');
    }
    const parsed = TidyWorktreeRemoveRequestSchema.safeParse(raw);
    if (!parsed.success) throw new ApiError(422, 'Name the exact worktree paths to remove', 'invalid_request');
    const cwd = await callerCwd(call, parsed.data.currentWorkingDirectory);
    return jsonResponse(TidyWorktreeRemoveResultSchema.parse(await service.remove(id, parsed.data.paths, cwd)));
  };
  return {
    'GET /v1/tidy/worktrees/:project': async (call: CallContext) => {
      if (call.request.query.size !== 0)
        throw new ApiError(400, 'This route takes no query parameters', 'unknown_parameter');
      return jsonResponse(TidyWorktreesSchema.parse(await service.list(project(call), await callerCwd(call))));
    },
    'POST /v1/tidy/worktrees/:project/remove': remove,
    'POST /v1/tidy/worktrees/:project/clean-merged': remove,
  } satisfies Record<string, RouteHandler>;
}
