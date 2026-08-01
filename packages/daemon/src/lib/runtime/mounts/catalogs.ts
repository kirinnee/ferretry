import type { ProjectList, SessionSkills, SessionView } from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { SessionDirectorySubsystem } from './sessions.ts';

/** The daemon-local catalogs that are safe to project to an authenticated paired client. */
export interface CatalogSubsystem {
  projects(): Promise<ProjectList>;
  skills(session: SessionView): Promise<SessionSkills>;
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

/**
 * Project paths and a session's harness are private daemon state, so these routes are admin-only.
 * They are no-store because a checkout or skill install may change the catalog while the PWA is open.
 */
export function catalogRoutes(catalogs: CatalogSubsystem, sessions: SessionDirectorySubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/projects',
      scope: 'admin',
      noStore: true,
      handle: async () => jsonResponse(await catalogs.projects()),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/skills',
      scope: 'admin',
      noStore: true,
      handle: async context => await skills(catalogs, sessions, context),
    },
  ];
}
