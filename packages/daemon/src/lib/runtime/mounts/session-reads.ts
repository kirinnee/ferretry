import { ApiError } from '../../api/error.ts';
import { decodeParameter, queryValue, type ApiResponse } from '../../api/http.ts';
import { jsonResponse, textResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { OperatorReadError, type OperatorReadFailure, type OperatorReadService } from '../../session/reads/index.ts';
import type { SessionDirectorySubsystem } from './sessions.ts';

/**
 * The operator READ surface: a session's durable event history, its live screen, and its transcript.
 *
 * WHY IT EXISTS. The protocol client has carried `snapshot`, `logs`, `events` and `history` since the
 * migration began and the daemon mounted none of them, so every one of them answered `unknown_route`.
 * A client method with no route is the shape this migration has now produced several times: it looks
 * like a capability in every type signature and is not one. These three routes are what make the
 * four client methods real, and `history` needs no route of its own — it is `events` paged, in the
 * client, over this route's exact cursor.
 *
 * WHY A 404 FROM THE SESSION READ COMES FIRST. Every route here asks the session directory whether the
 * session exists before it asks the subsystem for evidence about it. Without that, an unknown id and a
 * known id with no history would both answer an empty page, and "that session does not exist" would be
 * indistinguishable from "that session has done nothing" — which is the same failure the refusals
 * inside the subsystem exist to prevent, one layer up.
 *
 * WHAT IS DELIBERATELY NOT SERVED HERE. There is no live feed. `IFyApiClient.stream` opens a WebSocket
 * on `/v1/events`, and mounting that needs a broadcast bus the daemon does not have: nothing in it
 * publishes a journal append to a subscriber. Serving a socket that accepts a connection and then never
 * emits would be worse than the current honest `unknown_route`, because a silent stream and a quiet
 * session look identical. `fy stream` therefore follows this route's cursor instead, and says so.
 */

/** The HTTP status and code each refusal answers with. */
const REFUSALS: Readonly<Record<OperatorReadFailure, { readonly status: number; readonly code: string }>> = {
  invalid_query: { status: 400, code: 'invalid_query' },
  // 409 rather than 404: the session is real and the daemon knows it, and what is absent is the
  // terminal — a client that retries the same id later may well get a screen.
  no_terminal: { status: 409, code: 'no_terminal' },
  pane_dead: { status: 409, code: 'pane_dead' },
  no_transcript: { status: 409, code: 'no_transcript' },
  transcript_unreadable: { status: 409, code: 'transcript_unreadable' },
  event_evidence_mismatch: { status: 500, code: 'event_evidence_mismatch' },
};

/** The path parameter, decoded. A parameter that regains a separator never reaches the subsystem. */
function sessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

/** Restates a domain refusal in the HTTP vocabulary, preserving the code so a client need not match prose. */
function refuse(error: unknown): never {
  if (error instanceof OperatorReadError) {
    const refusal = REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  throw error;
}

/** Proves the session exists before any evidence about it is gathered. */
async function requireSession(sessions: SessionDirectorySubsystem, id: string): Promise<void> {
  const session = await sessions.get(id).catch(() => undefined);
  if (session === undefined) throw new ApiError(404, `no session ${id}`, 'not-found');
}

/**
 * A numeric query parameter.
 *
 * A value that is present and not a number is a 400 rather than a silent fall back to the default:
 * `?limit=all` means the caller wanted something this route does not offer, and answering the default
 * page would serve a bound they never asked for.
 */
function numberQuery(context: RouteContext, name: string): number | undefined {
  const raw = queryValue(context.request, name);
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new ApiError(400, `query parameter "${name}" must be a number`, 'invalid_query');
  return value;
}

async function events(
  reads: OperatorReadService,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  await requireSession(sessions, id);
  try {
    return jsonResponse(await reads.events(id, numberQuery(context, 'after') ?? 0, numberQuery(context, 'limit')));
  } catch (error) {
    return refuse(error);
  }
}

/**
 * The live screen.
 *
 * `?live` is accepted only as `true`. The legacy daemon's default was a stored last frame read from
 * disk, and this daemon writes none — so honouring `live=false` would mean answering the empty string
 * for every session, which reads as a blank terminal rather than as a missing feature. It is a stated
 * 501 instead, and the code names what is absent.
 */
async function snapshot(
  reads: OperatorReadService,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  const live = queryValue(context.request, 'live');
  if (live !== undefined && live !== 'true')
    throw new ApiError(
      501,
      'this daemon stores no last frame, so only live=true can be answered',
      'stored_snapshot_unavailable',
    );
  await requireSession(sessions, id);
  try {
    return textResponse(await reads.snapshot(id));
  } catch (error) {
    return refuse(error);
  }
}

/**
 * The session's own transcript tail, as text.
 *
 * `?turn` is REFUSED rather than ignored. Legacy `logs --turn N` read a per-turn log file this daemon
 * does not write; accepting the parameter and serving the whole tail would answer a different question
 * than the one asked, and a caller comparing two turns would be handed the same bytes twice.
 */
async function logs(
  reads: OperatorReadService,
  sessions: SessionDirectorySubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const id = sessionId(context);
  if (queryValue(context.request, 'turn') !== undefined)
    throw new ApiError(
      501,
      'this daemon keeps no per-turn log, so a transcript cannot be sliced by turn',
      'turn_partition_unavailable',
    );
  await requireSession(sessions, id);
  try {
    return textResponse(await reads.logs(id, numberQuery(context, 'limit')));
  } catch (error) {
    return refuse(error);
  }
}

/**
 * `admin` scope on all three: a pane capture is the agent's whole screen, a transcript is everything it
 * has said, and the journal carries the session's configuration in its lifecycle events. None of it is
 * warden-readable until a unit decides deliberately that it should be.
 *
 * `noStore` on all three for the reason the session view is: these are live state, and a cached answer
 * shows a session that has already moved on. It matters most for the snapshot, whose entire value is
 * that it is the screen as of now.
 *
 * All three are one-segment patterns under `/v1/sessions/:sessionId` ending in a literal no other route
 * uses, so none can shadow or be shadowed by the surfaces already mounted.
 */
export function sessionReadRoutes(
  reads: OperatorReadService,
  sessions: SessionDirectorySubsystem,
): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/events',
      scope: 'admin',
      noStore: true,
      handle: async context => await events(reads, sessions, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/snapshot',
      scope: 'admin',
      noStore: true,
      handle: async context => await snapshot(reads, sessions, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/logs',
      scope: 'admin',
      noStore: true,
      handle: async context => await logs(reads, sessions, context),
    },
  ];
}
