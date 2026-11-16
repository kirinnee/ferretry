import { ApiError, decodeParameter, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import {
  ProjectIdSchema,
  ProjectPathMustBeAbsoluteMessage,
  type RegisterProjectRequest,
  RegisterProjectRequestSchema,
} from '../../contract/index.ts';
import { parseBody } from './body.ts';
import type { ProjectRegistry } from './registry.ts';

/** `GET /v1/projects`: the registered folders, oldest first. */
export const listRoute =
  (registry: ProjectRegistry): RouteHandler =>
  async () =>
    jsonResponse(await registry.list());

/**
 * `POST /v1/projects`. A sole `path` policy failure is a parseable request the daemon refuses (422), unlike a
 * malformed registration body (400): parseBody's structured issues are kept long enough to tell them apart without
 * treating every schema-invalid value as policy-refused.
 */
export const registerRoute =
  (registry: ProjectRegistry): RouteHandler =>
  async call => {
    let request: RegisterProjectRequest;
    try {
      request = await parseBody(call.request, RegisterProjectRequestSchema);
    } catch (error) {
      const relativePathOnly =
        error instanceof ApiError &&
        error.code === 'invalid_request' &&
        error.validationIssues?.length === 1 &&
        error.validationIssues[0]?.path.length === 1 &&
        error.validationIssues[0].path[0] === 'path' &&
        error.validationIssues[0].message === ProjectPathMustBeAbsoluteMessage;
      if (relativePathOnly) throw new ApiError(422, (error as ApiError).message, 'project_registration_failed');
      throw error;
    }
    const registered = await registry.register(request);
    if (!registered.ok) throw new ApiError(422, registered.error.message, 'project_registration_failed');
    return jsonResponse(registered.value);
  };

/** `DELETE /v1/projects/:id`: forgets a project and answers the record it removed. The folder is left alone. */
export const removeRoute =
  (registry: ProjectRegistry): RouteHandler =>
  async call => {
    const decoded = decodeParameter(call.params.get('id') ?? '');
    const id = ProjectIdSchema.safeParse(decoded);
    if (!id.success) throw new ApiError(400, 'the project id in the path is not usable', 'invalid_project_id');
    const removed = await registry.remove(id.data);
    if (!removed.ok) throw new ApiError(404, removed.error.message, 'not-found');
    return jsonResponse(removed.value);
  };
