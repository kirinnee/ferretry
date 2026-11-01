import {
  type MachineSkillsInventory,
  type ProjectInfo,
  type ProjectList,
  ProjectPathMustBeAbsoluteMessage,
  type RegisterProjectRequest,
  RegisterProjectRequestSchema,
  type SessionSkills,
  type SessionSkillsInventory,
  type SessionView,
  SkillFileSchema,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter, queryValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { SessionDirectorySubsystem } from './sessions.ts';

/** The daemon-local catalogs that are safe to project to an authenticated paired client. */
export interface CatalogSubsystem {
  projects(): Promise<ProjectList>;
  registerProject(request: RegisterProjectRequest): Promise<ProjectInfo>;
  skills(session: SessionView): Promise<SessionSkills>;
  /** Every runtime home's and registered project's skills (`GET /v1/skills`). */
  skillsInventory(): Promise<MachineSkillsInventory>;
  /** Exactly what one session's ferret sees. */
  sessionSkillsInventory(session: SessionView): Promise<SessionSkillsInventory>;
  /**
   * The SKILL.md text for `path`, or `undefined` when no inventory visible to the caller lists that exact path.
   * `session` widens the check to that session's own listing (its working directory may be no registered project).
   */
  skillFile(path: string, session?: SessionView): Promise<string | undefined>;
}

async function registerProject(catalogs: CatalogSubsystem, context: RouteContext): Promise<ApiResponse> {
  try {
    return jsonResponse(await catalogs.registerProject(await parseBody(context.request, RegisterProjectRequestSchema)));
  } catch (error) {
    // A sole `path` policy failure is a parseable request the daemon refuses (422), unlike a
    // malformed registration body (400). Retain parseBody's structured issues long enough to
    // make that distinction without treating every schema-invalid JSON value as policy-refused.
    const relativePathOnly =
      error instanceof ApiError &&
      error.code === 'invalid_request' &&
      error.validationIssues?.length === 1 &&
      error.validationIssues[0]?.path.length === 1 &&
      error.validationIssues[0].path[0] === 'path' &&
      error.validationIssues[0].message === ProjectPathMustBeAbsoluteMessage;
    if (relativePathOnly) {
      throw new ApiError(422, error.message, 'project_registration_failed');
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      422,
      error instanceof Error ? error.message : 'the project could not be registered',
      'project_registration_failed',
    );
  }
}

function sessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

async function skills(
  catalogs: CatalogSubsystem,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  const session = await sessions.get(id);
  if (session === undefined) throw new ApiError(404, `no session ${id}`, 'not-found');
  return jsonResponse(await catalogs.skills(session));
}

async function sessionSkillsInventory(
  catalogs: CatalogSubsystem,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  const session = await sessions.get(id);
  if (session === undefined) throw new ApiError(404, `no session ${id}`, 'not-found');
  return jsonResponse(await catalogs.sessionSkillsInventory(session));
}

async function skillFile(
  catalogs: CatalogSubsystem,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const path = queryValue(context.request, 'path');
  if (path === undefined || path === '') throw new ApiError(400, 'query parameter "path" is required', 'invalid_path');
  const owner = queryValue(context.request, 'sessionId');
  const session = owner === undefined || owner === '' ? undefined : await sessions.get(owner);
  if (owner !== undefined && owner !== '' && session === undefined)
    throw new ApiError(404, `no session ${owner}`, 'not-found');
  const content = await catalogs.skillFile(path, session);
  if (content === undefined) throw new ApiError(404, 'no listed skill has that path', 'not-found');
  return jsonResponse(SkillFileSchema.parse({ path, content }));
}

/**
 * Project paths and a session's harness are private daemon state, so these routes are admin-only.
 * They are no-store because a checkout or skill install may change the catalog while the PWA is open.
 */
export function catalogRoutes(catalogs: CatalogSubsystem, sessions: SessionDirectorySubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/projects',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async () => jsonResponse(await catalogs.projects()),
    },
    {
      method: 'POST',
      path: '/v1/projects',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'filesystem', axis: 'configure' },
      noStore: true,
      handle: async context => await registerProject(catalogs, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/skills',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await skills(catalogs, sessions, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/skills/inventory',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await sessionSkillsInventory(catalogs, sessions, context),
    },
    {
      method: 'GET',
      path: '/v1/skills',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'fleet', axis: 'use' },
      noStore: true,
      handle: async () => jsonResponse(await catalogs.skillsInventory()),
    },
    {
      // The inventory's Open: the one route that returns SKILL.md text, and only for a path the inventory lists.
      method: 'GET',
      path: '/v1/skills/file',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'filesystem', axis: 'use' },
      noStore: true,
      handle: async context => await skillFile(catalogs, sessions, context),
    },
  ];
}
