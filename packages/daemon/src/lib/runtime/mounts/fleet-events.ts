import { CONFIG_CHANGE_TOPIC, SESSION_LIVE_STREAM_FLAG } from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import { queryValues } from '../../api/http.ts';
import type { RouteContext } from '../../api/route.ts';
import type { SocketDownstream, SocketHandler, SocketRoute } from '../../api/socket.ts';
import { FLEET_EVENT_BACKLOG_LIMIT, type FleetEventStreamScope } from '../../session/events/index.ts';
import { tryParseSessionId } from '../../session-id.ts';
import type { SessionDirectorySubsystem } from './sessions.ts';

export interface FleetEventStreamSubsystem {
  handler(scope: FleetEventStreamScope, downstream: SocketDownstream): SocketHandler;
}

/** The configuration stream: `?topic=config` on the same route (docs/config-files.md "Live changes"). */
export interface ConfigChangeStreamSubsystem {
  handler(downstream: SocketDownstream): SocketHandler;
}

function soleQuery(context: RouteContext, name: string): string | undefined {
  const values = queryValues(context.request, name);
  if (values.length > 1) throw new ApiError(400, `query parameter "${name}" may appear only once`, 'invalid_query');
  return values[0];
}

/** Whether this upgrade asks for the configuration stream rather than session events. */
function isConfigTopic(context: RouteContext): boolean {
  const topic = soleQuery(context, 'topic');
  if (topic === undefined) return false;
  if (topic !== CONFIG_CHANGE_TOPIC) throw new ApiError(400, `unknown event-stream topic "${topic}"`, 'invalid_query');
  for (const name of context.request.query.keys()) {
    if (name !== 'topic' && name !== 'token' && name !== 'ticket')
      throw new ApiError(400, `the configuration stream takes no "${name}" parameter`, 'invalid_query');
  }
  return true;
}

/**
 * `?tail=`: how much of the recent fleet tail to replay before going live.
 *
 * WHY IT EXISTS. With no cursor to resume from, a fleet stream replayed the last
 * {@link FLEET_EVENT_BACKLOG_LIMIT} events on every connect — megabytes on a busy fleet, on a metered
 * relay, for a reader that has just read the session list and wants only what happens next. `tail=0`
 * is that reader's form: nothing replayed, live from the instant of subscription, and the opening
 * idle proof marks the edge. A daemon that predates the parameter refuses it as unknown, so a reader
 * decides from the daemon's version whether it may send it.
 */
function fleetTail(raw: string): number {
  const tail = Number(raw);
  if (!/^[0-9]+$/u.test(raw) || tail > FLEET_EVENT_BACKLOG_LIMIT)
    throw new ApiError(400, `tail must be an integer from 0 to ${FLEET_EVENT_BACKLOG_LIMIT}`, 'invalid_query');
  return tail;
}

async function scope(context: RouteContext, sessions: SessionDirectorySubsystem): Promise<FleetEventStreamScope> {
  for (const name of context.request.query.keys()) {
    // `token` and `ticket` are both consumed by the upgrade's authentication before the route is
    // reached — the first from a loopback peer, the second from a browser that cannot send a header
    // at all. Rejecting either here would refuse the only credential such a caller can present.
    if (
      name !== 'after' &&
      name !== 'sessionId' &&
      name !== 'live' &&
      name !== 'tail' &&
      name !== 'token' &&
      name !== 'ticket'
    )
      throw new ApiError(400, `unknown event-stream query parameter "${name}"`, 'invalid_query');
  }
  const rawAfter = soleQuery(context, 'after') ?? '0';
  const after = Number(rawAfter);
  if (!/^[0-9]+$/u.test(rawAfter) || !Number.isSafeInteger(after))
    throw new ApiError(400, 'after must be a non-negative integer', 'invalid_query');
  const rawLive = soleQuery(context, 'live');
  if (rawLive !== undefined && rawLive !== SESSION_LIVE_STREAM_FLAG)
    throw new ApiError(400, `live must be "${SESSION_LIVE_STREAM_FLAG}" when given`, 'invalid_query');
  const rawTail = soleQuery(context, 'tail');
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
    // A live readout is one turn's; the fleet has no one turn to read.
    if (rawLive !== undefined)
      throw new ApiError(400, 'a live readout follows one session; add sessionId', 'live_needs_session');
    return rawTail === undefined ? { kind: 'fleet' } : { kind: 'fleet', tail: fleetTail(rawTail) };
  }
  // One session resumes from its own cursor; a second way to say where to start would only disagree.
  if (rawTail !== undefined)
    throw new ApiError(400, 'tail bounds a fleet stream; follow one session with after', 'tail_needs_fleet');
  const id = tryParseSessionId(rawSessionId);
  if (id === undefined) throw new ApiError(400, 'sessionId is not a usable session id', 'invalid_session_id');
  const session = await sessions.get(id);
  if (session === undefined) throw new ApiError(404, `no session ${id}`, 'not-found');
  return { kind: 'session', sessionId: id, after, ...(rawLive === undefined ? {} : { live: true }) };
}

/** The optional-id event feed, mounted through the daemon's one socket dispatcher. */
export function fleetEventSocketRoutes(
  events: FleetEventStreamSubsystem,
  sessions: SessionDirectorySubsystem,
  configChanges: ConfigChangeStreamSubsystem,
): readonly SocketRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/events',
      minimum: 'operator',
      accept: async context => {
        if (isConfigTopic(context)) return async downstream => configChanges.handler(downstream);
        const requested = await scope(context, sessions);
        return async downstream => events.handler(requested, downstream);
      },
    },
  ];
}
