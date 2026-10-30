import { type FleetTaskListResponse, type SessionTaskListResponse, TASK_SCHEMA_VERSION } from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import { decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/**
 * DEPRECATED compatibility reads for the retired per-session task store.
 *
 * The cards moved to the project board (`/v1/board`), but a phone running an older PWA bundle and an
 * older `fy` still dial `GET /v1/sessions/:sessionId/tasks` and `GET /v1/tasks`, and parse the answer
 * with the v1 list schema. A 404 there renders as a broken pane; a schema-valid EMPTY list renders as
 * the empty state they already handle. These two reads therefore stay, answering nothing but the v1
 * shape, until the clients that parse it are gone.
 *
 * REMOVE AFTER ONE RELEASE (U18b): the PWA's session-task search and `&task` proof stop calling the
 * session route, and this file, its mount and its two allowlist lines go with them. Every write and the
 * per-task detail read are gone already — no shipped client reads a task record this way any more.
 */
export interface LegacyTaskSubsystem {
  /** The instant a list response is stamped with. */
  now(): string;
}

const sessionId = (context: RouteContext): string => {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the sessionId in the path is not usable', 'invalid_session_id');
  return decoded;
};

export function legacyTaskRoutes(subsystem: LegacyTaskSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/tasks',
      minimum: 'operator',
      noStore: true,
      handle: async () => {
        const response: FleetTaskListResponse = {
          v: TASK_SCHEMA_VERSION,
          sessionId: null,
          tasks: [],
          parseErrors: 0,
          updatedAt: subsystem.now(),
        };
        return jsonResponse(response);
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/tasks',
      minimum: 'operator',
      noStore: true,
      handle: async context => {
        const response: SessionTaskListResponse = {
          v: TASK_SCHEMA_VERSION,
          sessionId: sessionId(context),
          tasks: [],
          parseErrors: 0,
          updatedAt: subsystem.now(),
        };
        return jsonResponse(response);
      },
    },
  ];
}
