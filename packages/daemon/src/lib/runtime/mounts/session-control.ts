import {
  FY_REQUEST_ID_HEADER,
  StartSessionRequestSchema,
  StopSessionRequestSchema,
  type SessionView,
  type StartSessionRequest,
} from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, headerValue, type ApiRequest, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/**
 * The session WRITE surface: starting one, and stopping it.
 *
 * `POST /v1/sessions` and `POST /v1/sessions/:sessionId/stop` are the two routes `fy start` and
 * `fy stop` speak, and the daemon answered `unknown_route` to both — so every subsystem it mounts
 * was addressed by sessions the product had no way to create. `SessionLifecycleService` and its five
 * adapters were built and tested for exactly this and never called.
 *
 * WHAT THIS MOUNT REFUSES, AND WHY EACH REFUSAL IS BETTER THAN A GUESS. `StartSessionRequest`
 * carries two options this daemon cannot honour yet, and each is answered with `501` and a code
 * naming the missing unit rather than accepted and dropped:
 *
 *   * `boardAccess` other than `none` — a board grant is keyed on a per-session capability this
 *     daemon mints nowhere. Accepting the field would hand back a session whose caller believes it
 *     may write a board it cannot reach.
 *   * `initialAttachments` — nothing in the daemon stores an attachment blob, and an attachment
 *     silently discarded is worse than one refused: the agent would start without the file its task
 *     refers to.
 *
 * `detach` is accepted and needs no unit: it decides whether the CLIENT keeps its own terminal
 * attached after the start, and the daemon never had a terminal to attach. `teammate` and
 * `teammateFallback` are honoured by the allocator behind this mount, which CLAIMS the callsign
 * before the session document exists — a taken name is a `409` unless the caller asked for a
 * fallback, rather than a second session answering to a name that already resolves elsewhere.
 *
 * WHY THE REQUEST ID IS MANDATORY. The protocol client RETRIES this POST on a transport error and
 * then asks a recovery route which session that id produced. A start is the one request in the
 * daemon whose retry has a side effect nobody wants twice — a second pane, a second agent, a second
 * charge against the account — so a start with no id is refused rather than served unsafely.
 */

/** Why a start or a stop could not be served. */
export type SessionControlFailure =
  /** The request names something the daemon would have to invent — an unusable id, an absent cwd. */
  | 'invalid'
  /** No account in the fleet manifest is published under the requested agent. */
  | 'unknown_agent'
  /** The account exists and cannot serve a session right now, or this host cannot run its wrapper. */
  | 'unavailable'
  /** The session does not exist. */
  | 'not_found'
  /** The same request id was already spent on a different start. */
  | 'conflict'
  /** Another session already answers to the callsign this start asked for. */
  | 'callsign_taken'
  /** The launch itself failed, and the session records why. */
  | 'failed';

/** A refusal raised by the composition root's session control, in a taxonomy `src/lib` may name. */
export class SessionControlError extends Error {
  constructor(
    readonly failure: SessionControlFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionControlError';
  }
}

/**
 * Starting and stopping one session.
 *
 * `start` is IDEMPOTENT on the request id: the same id returns the session it already started
 * rather than starting a second one, and a different payload under a spent id is a conflict rather
 * than a silent second session.
 */
export interface SessionControlSubsystem {
  start(request: StartSessionRequest, requestId: string): Promise<SessionView>;
  stop(sessionId: string, reason: string | undefined): Promise<SessionView>;
}

/** The HTTP status and code each refusal answers with. */
const REFUSALS: Readonly<Record<SessionControlFailure, { readonly status: number; readonly code: string }>> = {
  invalid: { status: 400, code: 'invalid_request' },
  unknown_agent: { status: 404, code: 'unknown_agent' },
  unavailable: { status: 503, code: 'agent_unavailable' },
  not_found: { status: 404, code: 'not-found' },
  conflict: { status: 409, code: 'request_id_reused' },
  callsign_taken: { status: 409, code: 'callsign_taken' },
  failed: { status: 500, code: 'session_launch_failed' },
};

/** Restates a control refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof SessionControlError) {
    const refusal = REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  throw error;
}

/** The raw path parameter, decoded. A parameter that regains a separator never reaches the service. */
function pathSessionId(context: RouteContext): string {
  const raw = context.params.get('sessionId') ?? '';
  const decoded = decodeParameter(raw);
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

/** The request body as JSON, or a stated refusal. */
async function body(request: ApiRequest): Promise<unknown> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new ApiError(400, 'the request body could not be read', 'unreadable_body');
  }
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not valid JSON', 'invalid_json');
  }
}

/** The failing fields, named without echoing what was submitted back out. */
function issueDetail(issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }>) {
  return issues
    .map(issue => `${issue.path.join('.') === '' ? 'body' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/** The start request, validated at the boundary and checked against what this daemon mounts. */
async function parseStart(request: ApiRequest): Promise<StartSessionRequest> {
  const parsed = StartSessionRequestSchema.safeParse(await body(request));
  if (!parsed.success)
    throw new ApiError(400, `the request body is invalid — ${issueDetail(parsed.error.issues)}`, 'invalid_request');
  const start = parsed.data;
  if (start.boardAccess !== 'none')
    throw new ApiError(
      501,
      'task board access is not mounted: a board grant needs a per-session capability this daemon does not mint yet',
      'board_access_not_mounted',
    );
  if (start.initialAttachments !== undefined && start.initialAttachments.length > 0)
    throw new ApiError(
      501,
      'attachments are not mounted: this daemon stores no attachment blob, so an agent would start without the file',
      'attachments_not_mounted',
    );
  return start;
}

/** The logical request id the retry contract is built on. */
function requestId(request: ApiRequest): string {
  const value = headerValue(request, FY_REQUEST_ID_HEADER)?.trim() ?? '';
  if (value === '')
    throw new ApiError(
      400,
      `a start must carry ${FY_REQUEST_ID_HEADER}: without it a retried request starts a second session`,
      'missing_request_id',
    );
  return value;
}

/** Starts a session, or answers with the one this request id already started. */
async function start(subsystem: SessionControlSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseStart(context.request);
  const id = requestId(context.request);
  const view = await subsystem.start(request, id).catch(refuse);
  return jsonResponse(view, 201);
}

/** Stops a session, or answers a stated refusal. */
async function stop(subsystem: SessionControlSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const parsed = StopSessionRequestSchema.safeParse(await body(context.request));
  if (!parsed.success)
    throw new ApiError(400, `the request body is invalid — ${issueDetail(parsed.error.issues)}`, 'invalid_request');
  const view = await subsystem.stop(sessionId, parsed.data.reason).catch(refuse);
  return jsonResponse(view);
}

/**
 * `admin` scope for both: a start spawns a process holding the daemon's own privileges and a stop
 * kills one, so neither is warden-reachable until a unit decides deliberately that it should be.
 *
 * `noStore` because both answer with a live session view — status, turn and last activity — and a
 * cached one shows a session that has already moved on.
 */
export function sessionControlRoutes(subsystem: SessionControlSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions',
      scope: 'admin',
      noStore: true,
      handle: async context => await start(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/stop',
      scope: 'admin',
      noStore: true,
      handle: async context => await stop(subsystem, context),
    },
  ];
}
