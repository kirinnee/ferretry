import {
  FY_REQUEST_ID_HEADER,
  STEP_UP_REQUIRED_CODE,
  StartSessionRequestSchema,
  type StepUpRequiredBody,
  StopSessionRequestSchema,
  type SessionView,
  type StartSessionRequest,
} from '@ferretry/protocol';
import { posix } from 'node:path';
import { type CapabilityDemand, type CapabilityGuard, grantRefusalCode } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, headerValue, type ApiRequest, type ApiResponse } from '../../api/http.ts';
import { errorResponse, jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { Delegation } from '../../board/index.ts';

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
 * `initialAttachments` USED TO BE A REFUSAL, and it is served now. It is not the multipart
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
  /**
   * The caller named a model this account does not serve.
   *
   * SEPARATE FROM `unavailable`, because the two have opposite remedies. An unavailable account is
   * something to wait for or repair; an account that does not serve the named model is working
   * perfectly and would start a session for any model it does declare. Folding this into
   * `unavailable` would answer `503` and invite a retry that can only fail again.
   */
  | 'unservable_model'
  /** The session does not exist. */
  | 'not_found'
  /** The same request id was already spent on a different start. */
  | 'conflict'
  /** Another session already answers to the callsign this start asked for. */
  | 'callsign_taken'
  /** The callsign reservation store could not be read or written, so no name can be claimed safely. */
  | 'callsign_unavailable'
  /** The launch itself failed, and the session records why. */
  | 'failed'
  /** A stop found a launch of the same session still in flight and stopped nothing; ask again once it settles. */
  | 'pending'
  /** The parent already runs as many sub-ferrets as Pack mode's limit allows (docs/pack-mode.md). */
  | 'limit_reached'
  /** A sub-ferret this deep may not start its own (docs/pack-mode.md). */
  | 'depth_exceeded';

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
   * `delegation` is a `fy new`'s card, reserved by the daemon before the start (`SessionCards.delegate`):
   * the started session's card is then the lead's, under the lead's focus card. It never comes from a
   * request body. Without it a start with a prompt gets a card of its own.
   */
  start(
    request: StartSessionRequest,
    requestId: string,
    payload: string,
    delegation?: Delegation,
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
  // 409 rather than 503 or 400: the request is well formed and the account is a perfectly good
  // target — it is this MODEL that it does not serve. The remedy is to name one it does, or to
  // declare this one on the account, and neither is a retry of the same request.
  unservable_model: { status: 409, code: 'unservable_model' },
  not_found: { status: 404, code: 'not-found' },
  conflict: { status: 409, code: 'request_id_reused' },
  callsign_taken: { status: 409, code: 'callsign_taken' },
  callsign_unavailable: { status: 503, code: 'callsign_unavailable' },
  failed: { status: 500, code: 'session_launch_failed' },
  // 409: nothing was attempted, and the same stop succeeds once the launch it waited for settles.
  pending: { status: 409, code: 'session_launch_pending' },
  // 409: the request is well formed and would be served once the parent has fewer running children,
  // or by a shallower ferret — not by retrying it as it is.
  limit_reached: { status: 409, code: 'limit_reached' },
  depth_exceeded: { status: 409, code: 'depth_exceeded' },
};

/** Restates a control refusal in the HTTP vocabulary; anything else is not ours to translate. */
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
/**
 * What a start needs to decide whether it is a TERMINAL in disguise.
 *
 * A start that chooses the harness's own flags, or a working directory outside every project this
 * daemon knows, can run any command on the host — `--settings` with a hook, for one. So for a governed
 * caller it is decided as `terminal.use` (review R2-H1): under the default settings the unlock already
 * covers it; with `stepUpOnActions` on, or the unlock off, it asks for a passkey like a terminal does.
 * A plain start in a known project is an ordinary act and asks for nothing more.
 */
export interface SessionLaunchGate {
  readonly guard: CapabilityGuard;
  /** The folders a session may start in as an ordinary act: registered projects and the worktree root. */
  readonly knownRoots: () => Promise<readonly string[]>;
}

const TERMINAL_USE: CapabilityDemand = { capability: 'terminal', axis: 'use' };

/**
 * Registered projects, and the managed-worktree root every worktree session runs under. Read per start,
 * so a project registered a moment ago is known at once.
 */
export const knownLaunchRoots =
  (
    catalogs: { projects(): Promise<readonly { readonly path: string }[]> },
    worktrees: { list(): Promise<{ readonly managedRoot?: string | undefined }> },
  ) =>
  async (): Promise<readonly string[]> => {
    const [projects, managed] = await Promise.all([catalogs.projects(), worktrees.list()]);
    return [
      ...projects.map(project => project.path),
      ...(managed.managedRoot === undefined ? [] : [managed.managedRoot]),
    ];
  };

/** Whether `path` is `root` or inside it, lexically. Both are absolute (the start schema requires it). */
const within = (path: string, root: string): boolean => {
  const target = posix.normalize(path);
  const base = posix.normalize(root).replace(/\/+$/u, '');
  return target === base || target.startsWith(`${base}/`);
};

/** The refusal a terminal-class start gets from a governed caller, or nothing when it may proceed. */
async function launchRefusal(
  gate: SessionLaunchGate,
  context: RouteContext,
  request: StartSessionRequest,
): Promise<ApiResponse | undefined> {
  const presentation = context.presentation;
  if (presentation === undefined || presentation.loopback) return undefined;
  const flagged = (request.harnessFlags ?? []).length > 0;
  const cwd = request.cwd;
  const outside = cwd !== undefined && !(await gate.knownRoots()).some(root => within(cwd, root));
  if (!flagged && !outside) return undefined;
  const decision = gate.guard.decide(TERMINAL_USE, presentation);
  if (decision.allowed) {
    // A single-use step-up (window 0) is spent by the act it allowed, exactly as the boundary spends one.
    context.spendStepUp?.();
    return undefined;
  }
  const message =
    gate.guard.explain(TERMINAL_USE, decision.refusal) ??
    'starting an agent with its own flags, or outside every project, is terminal access';
  return decision.refusal === 'step-up-required'
    ? jsonResponse(
        { error: message, code: STEP_UP_REQUIRED_CODE, demand: TERMINAL_USE } satisfies StepUpRequiredBody,
        403,
      )
    : errorResponse(403, message, grantRefusalCode(decision.refusal));
}

async function start(
  subsystem: SessionControlSubsystem,
  gate: SessionLaunchGate,
  context: RouteContext,
): Promise<ApiResponse> {
  // The BYTES, kept as well as the request they parse into: the recovery route below addresses a
  // start by the digest of exactly what was sent, so a re-serialization of the parsed value would
  // not necessarily hash to the same thing the client hashed.
  const payload = await bodyText(context.request);
  const request = parseStart(payload);
  const refused = await launchRefusal(gate, context, request);
  if (refused !== undefined) return refused;
  const id = requestId(context.request);
  const view = await subsystem.start(request, id, payload).catch(refuse);
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
export function sessionControlRoutes(subsystem: SessionControlSubsystem, gate: SessionLaunchGate): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions',
      minimum: 'operator',
      noStore: true,
      handle: async context => await start(subsystem, gate, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/stop',
      minimum: 'operator',
      noStore: true,
      handle: async context => await stop(subsystem, context),
    },
    // Four segments deep, so the one-segment `GET /v1/sessions/:sessionId` above cannot match it and
    // `by-request` can never be mistaken for a session id.
    {
      method: 'GET',
      path: '/v1/sessions/by-request/:requestId',
      minimum: 'operator',
      noStore: true,
      handle: async context => await recover(subsystem, context),
    },
  ];
}
