import { SessionAgendaModePatchSchema, type SessionAgendaMode } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { SessionAgendaModeError } from '../../session/agenda-mode/service.ts';

/**
 * Reading and switching whether one ferret keeps an agenda: `GET` and `PATCH /v1/sessions/:sessionId/agenda-mode`
 * (docs/agenda.md). The answer is the switch, whether a restart is needed for it to take effect, and that said
 * in words.
 *
 * `operator` scope and no capability, like the hypermedia and Pack switches: it is a write to a session's own
 * configuration, it grants nothing, and it changes only what the ferret is told at its next launch.
 */
export interface SessionAgendaModeSubsystem {
  get(sessionId: string): Promise<SessionAgendaMode>;
  set(sessionId: string, enabled: boolean): Promise<SessionAgendaMode>;
}

function refuse(error: unknown): never {
  if (error instanceof SessionAgendaModeError) throw new ApiError(404, error.message, 'not-found');
  throw error;
}

function sessionOf(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

async function patch(subsystem: SessionAgendaModeSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = sessionOf(context);
  const request = await parseBody(context.request, SessionAgendaModePatchSchema);
  return jsonResponse(await subsystem.set(sessionId, request.enabled).catch(refuse));
}

/** `noStore` because the answer is the live switch. */
export function sessionAgendaModeRoutes(subsystem: SessionAgendaModeSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/agenda-mode',
      minimum: 'operator',
      noStore: true,
      handle: async context => jsonResponse(await subsystem.get(sessionOf(context)).catch(refuse)),
    },
    {
      method: 'PATCH',
      path: '/v1/sessions/:sessionId/agenda-mode',
      minimum: 'operator',
      noStore: true,
      handle: async context => await patch(subsystem, context),
    },
  ];
}
