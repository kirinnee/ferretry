import { ApiError } from '../../api/error.ts';
import { queryValues } from '../../api/http.ts';
import type { RouteContext } from '../../api/route.ts';
import type { SocketDownstream, SocketHandler, SocketRoute } from '../../api/socket.ts';
import type { FleetEventStreamScope } from '../../session/events/index.ts';
import { tryParseSessionId } from '../../session-id.ts';
import type { SessionDirectorySubsystem } from './sessions.ts';

export interface FleetEventStreamSubsystem {
  handler(scope: FleetEventStreamScope, downstream: SocketDownstream): SocketHandler;
}

function soleQuery(context: RouteContext, name: string): string | undefined {
  const values = queryValues(context.request, name);
  if (values.length > 1) throw new ApiError(400, `query parameter "${name}" may appear only once`, 'invalid_query');
  return values[0];
}

async function scope(context: RouteContext, sessions: SessionDirectorySubsystem): Promise<FleetEventStreamScope> {
  for (const name of context.request.query.keys()) {
    // `token` is consumed by loopback WebSocket authentication before the route is reached.
    if (name !== 'after' && name !== 'sessionId' && name !== 'token')
      throw new ApiError(400, `unknown event-stream query parameter "${name}"`, 'invalid_query');
  }
  const rawAfter = soleQuery(context, 'after') ?? '0';
  const after = Number(rawAfter);
  if (!/^[0-9]+$/u.test(rawAfter) || !Number.isSafeInteger(after))
    throw new ApiError(400, 'after must be a non-negative integer', 'invalid_query');
  const rawSessionId = soleQuery(context, 'sessionId');
  if (rawSessionId === undefined) {
    // There is no global sequence domain: the source-compatible fleet form is a bounded recent tail,
    // then live. Refusing a non-zero number keeps it from pretending to resume a cursor it cannot own.
    if (after !== 0)
      throw new ApiError(
        400,
        'a fleet stream has no global cursor; omit --after or follow one session',
        'fleet_cursor_unavailable',
      );
    return { kind: 'fleet' };
  }
  const id = tryParseSessionId(rawSessionId);
  if (id === undefined) throw new ApiError(400, 'sessionId is not a usable session id', 'invalid_session_id');
  const session = await sessions.get(id);
  if (session === undefined) throw new ApiError(404, `no session ${id}`, 'not-found');
  return { kind: 'session', sessionId: id, after };
}

/** The optional-id event feed, mounted through the daemon's one socket dispatcher. */
export function fleetEventSocketRoutes(
  events: FleetEventStreamSubsystem,
  sessions: SessionDirectorySubsystem,
): readonly SocketRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/events',
      scope: 'admin',
      accept: async context => {
        const requested = await scope(context, sessions);
        return async downstream => events.handler(requested, downstream);
      },
    },
  ];
}
