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
import { BOARD_CAPABILITY_HEADER, reraiseTaskBoardError } from './task-boards.ts';

/**
 * The session WRITE surface: starting one, stopping it, and recovering a start whose answer was lost.
 *
 * `POST /v1/sessions` and `POST /v1/sessions/:sessionId/stop` are the two routes `fy start` and
 * `fy stop` speak, and the daemon answered `unknown_route` to both — so every subsystem it mounts
 * was addressed by sessions the product had no way to create. `SessionLifecycleService` and its five
 * adapters were built and tested for exactly this and never called.
 *
 * `GET /v1/sessions/by-request/:requestId` completes that pair rather than adding a third capability:
 * it is the LAST step of the retry contract the start's request id exists for, and the client reaches
 * it only after both its POST attempts failed in transport. See `recover` below for why the payload
 * digest is mandatory.
 *
 * `boardAccess` IS SERVED NOW, AND THE 501 IT USED TO ANSWER WAS WRONG ABOUT THE WIRE. The recorded
 * reason said a start "would launch a pane holding a capability that authorizes nothing until a third
 * party acts". A start hands the pane no capability at all: `--board-access worker` asks for a child
 * grant, and a child grant is a PENDING INTENT by construction — `TaskBoardChildGrantService.request`
 * has no approval branch for any requester, coordinator included. So the pending state this refused
 * to produce is the only state the domain can produce, and refusing it meant `fy start --board-access`
 * could not be run at all.
 *
 * WHAT THE WIRE SAYS, read rather than inferred. `IFyApiClient.start` sends the parent's own board
 * capability on `x-fy-board-capability` with THIS request — the header has no other purpose on this
 * surface — and its happy path returns the session without asking the board for anything. It requests
 * the grant itself on exactly one path: after both POSTs died in transport and the recovery read
 * found the session, because there it cannot know how far the daemon got. Those two facts only fit
 * together one way: the daemon owns the grant, and the recovery re-ask is a repair. It is safe to
 * repeat because the board derives the request id from the operation's own identity, so both asks
 * hash to one id and the second replays.
 *
 * WHEN THE BOARD REFUSES, THE SESSION IS RETIRED RATHER THAN LEFT RUNNING. The grant is requested
 * after the session record exists — the board must be able to see the target — and BEFORE the pane is
 * launched, so a refusal costs no agent. The record is then stopped with the board's own reason in
 * it, and the refusal is restated with the same status the standalone grant route would have given.
 * The alternative, answering `201` with a session whose grant was refused, would tell the caller it
 * had board access pending when nothing is pending at all.
 *
 * `initialAttachments` USED TO BE THE SECOND REFUSAL, and it is served now. It is not the multipart
 * upload route and never needed one: the bytes travel INLINE as base64 in this very body, and the only
 * place they are spent is the turn-one document this start writes. The composition root stores each
 * file in the session's own directory, extracts a DOCX into text beside it, and names both in the
 * opening message — so `fy start -f report.docx` hands the agent the file its task refers to.
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
 * Starting and stopping one session, and recovering a start whose answer was lost.
 *
 * `start` is IDEMPOTENT on the request id: the same id returns the session it already started
 * rather than starting a second one, and a different payload under a spent id is a conflict rather
 * than a silent second session. The payload travels as the RAW body text, because that is what the
 * client digests when it comes back to `recover` — comparing a re-serialization of the parsed value
 * would compare something neither side ever put on the wire.
 */
export interface SessionControlSubsystem {
  /**
   * `boardCapability` is the REQUESTING session's own board secret, present exactly when the start
   * asks for board access. It is what the child grant is authorized by, so it travels to the
   * subsystem rather than being read from anything the start's body could name: a body field would
   * be a caller-controlled claim about who is asking, and on a board that is a privilege escalation.
   */
  start(
    request: StartSessionRequest,
    requestId: string,
    payload: string,
    boardCapability?: string,
  ): Promise<SessionView>;
  stop(sessionId: string, reason: string | undefined): Promise<SessionView>;
  /**
   * The session this request id started, for a caller that can prove it sent the same body.
   *
   * `undefined` means no start under that id, which is the honest answer for a request that never
   * reached the daemon. A digest that disagrees is a CONFLICT rather than a miss: that id did start
   * a session, and it is not the one the caller is describing.
   */
  recover(requestId: string, payloadDigest: string): Promise<SessionView | undefined>;
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

/**
 * Restates a control refusal in the HTTP vocabulary.
 *
 * A BOARD refusal passes through the board's own table rather than being folded into one of the
 * failures above. A start that asked for board access and was refused it failed for a board reason —
 * "you are not a membership root", "the board has no live coordinator" — and the caller must be able
 * to read that answer the same way it reads the standalone grant route's, which is the route it will
 * retry on. Flattening every one of them into `session_launch_failed` would hide which.
 */
function refuse(error: unknown): never {
  if (error instanceof SessionControlError) {
    const refusal = REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  reraiseTaskBoardError(error);
}

/** The raw path parameter, decoded. A parameter that regains a separator never reaches the service. */
function pathSessionId(context: RouteContext): string {
  const raw = context.params.get('sessionId') ?? '';
  const decoded = decodeParameter(raw);
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

/** The request body as text, or a stated refusal. */
async function bodyText(request: ApiRequest): Promise<string> {
  try {
    return await request.text();
  } catch {
    throw new ApiError(400, 'the request body could not be read', 'unreadable_body');
  }
}

/** Body text as JSON. An absent body is the no-fields case; malformed JSON never is. */
function bodyJson(text: string): unknown {
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'the request body is not valid JSON', 'invalid_json');
  }
}

/** The request body as JSON, or a stated refusal. */
async function body(request: ApiRequest): Promise<unknown> {
  return bodyJson(await bodyText(request));
}

/** The failing fields, named without echoing what was submitted back out. */
function issueDetail(issues: ReadonlyArray<{ readonly path: ReadonlyArray<PropertyKey>; readonly message: string }>) {
  return issues
    .map(issue => `${issue.path.join('.') === '' ? 'body' : issue.path.join('.')}: ${issue.message}`)
    .join('; ');
}

/** The start request, validated at the boundary. */
function parseStart(text: string): StartSessionRequest {
  const parsed = StartSessionRequestSchema.safeParse(bodyJson(text));
  if (!parsed.success)
    throw new ApiError(400, `the request body is invalid — ${issueDetail(parsed.error.issues)}`, 'invalid_request');
  return parsed.data;
}

/**
 * The parent's own board capability, required exactly when the start asks for board access.
 *
 * `401` rather than `400` because it is a missing SECRET, which is how every other board route reports
 * the same absence — a caller that reads one of them can read this one. A `none` start never reads the
 * header at all, so an operator's ordinary `fy start` is unaffected by whether one is set.
 */
function boardCapability(request: ApiRequest, start: StartSessionRequest): string | undefined {
  if (start.boardAccess === 'none') return undefined;
  const value = headerValue(request, BOARD_CAPABILITY_HEADER)?.trim();
  if (value === undefined || value === '')
    throw new ApiError(
      401,
      `a start asking for ${start.boardAccess} board access must present the requesting session's own board capability on ${BOARD_CAPABILITY_HEADER}`,
      'missing_capability',
    );
  return value;
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
  // The BYTES, kept as well as the request they parse into: the recovery route below addresses a
  // start by the digest of exactly what was sent, so a re-serialization of the parsed value would
  // not necessarily hash to the same thing the client hashed.
  const payload = await bodyText(context.request);
  const request = parseStart(payload);
  const capability = boardCapability(context.request, request);
  const id = requestId(context.request);
  const view = await subsystem.start(request, id, payload, capability).catch(refuse);
  return jsonResponse(view, 201);
}

/** The payload digest the caller says it sent. Required: it is the whole proof. */
function payloadDigest(context: RouteContext): string {
  const value = context.request.query.get('payload')?.[0]?.trim() ?? '';
  if (value === '')
    throw new ApiError(
      400,
      'a recovery read must carry ?payload=<sha-256 of the start body>: without it any caller could ask which session a request id produced',
      'missing_payload_digest',
    );
  return value;
}

/**
 * Which session a request id already started.
 *
 * THIS IS THE THIRD STEP OF THE START'S OWN RETRY CONTRACT, and the daemon answered
 * `unknown_route` to it. The protocol client posts the start, retries the identical POST on a
 * transport error, and if THAT also fails it asks here — because a start whose response was lost
 * may well have succeeded, and without this the human is handed a transport error beside a session
 * they never learn is running.
 *
 * THE DIGEST IS THE AUTHORIZATION, not an optimisation. A logical request id travels in a header
 * and is chosen by the client, so answering it on its own would let any caller holding the admin
 * token enumerate other callers' request ids and learn which sessions they started. Proving
 * knowledge of the exact body means only the caller that actually made the start can recover it.
 */
async function recover(subsystem: SessionControlSubsystem, context: RouteContext): Promise<ApiResponse> {
  const raw = context.params.get('requestId') ?? '';
  const id = decodeParameter(raw);
  if (id === undefined || id === '')
    throw new ApiError(400, 'the request id in the path is not usable', 'invalid_request_id');
  const view = await subsystem.recover(id, payloadDigest(context)).catch(refuse);
  if (view === undefined)
    throw new ApiError(404, `no start by this daemon carries request id ${JSON.stringify(id)}`, 'not-found');
  return jsonResponse(view);
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
 * `admin` scope for all three: a start spawns a process holding the daemon's own privileges and a
 * stop kills one, and the recovery read answers with the same session view those two do — so none is
 * warden-reachable until a unit decides deliberately that it should be.
 *
 * `noStore` because all three answer with a live session view — status, turn and last activity — and
 * a cached one shows a session that has already moved on. It matters most on the recovery read, which
 * is a GET: an intermediary that cached it would keep answering for a request id after the session it
 * names has stopped.
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
    // Four segments deep, so the one-segment `GET /v1/sessions/:sessionId` above cannot match it and
    // `by-request` can never be mistaken for a session id.
    {
      method: 'GET',
      path: '/v1/sessions/by-request/:requestId',
      scope: 'admin',
      noStore: true,
      handle: async context => await recover(subsystem, context),
    },
  ];
}
