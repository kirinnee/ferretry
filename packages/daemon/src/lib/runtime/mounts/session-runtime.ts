import {
  FY_REQUEST_ID_HEADER,
  RuntimeControlRequestSchema,
  type RuntimeControlRequest,
  type RuntimeModelCatalog,
  type SessionView,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, headerValue, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/**
 * Changing the model and the reasoning level of a session that is already running, and reading what
 * it may be changed TO: `GET /v1/sessions/:sessionId/runtime-models` and
 * `POST /v1/sessions/:sessionId/runtime`.
 *
 * BOTH ROUTES WERE DECLARED DEFECTS BEFORE THIS MOUNT EXISTED. The browser ships the whole surface —
 * a model chip and a reasoning chip, each with its own sheet, each with per-harness semantics — and
 * every one of them dialled a `404`. The repository's own route-agreement contract carried the two
 * addresses as known disagreements, so closing this costs exactly those two lines.
 *
 * THE TWO CHIPS ARE INDEPENDENT AND THAT IS THE FEATURE, not an implementation detail. The request
 * union says so: `{action:'effort'}` changes a level without naming a model, `{action:'model'}` names
 * a model and may name a level with it, and a bare `{action:'model'}` opens the harness's own picker
 * and claims nothing about what a human then chose. Nothing here folds one into the other.
 *
 * WHAT THE CATALOG IS NOT. It is not a table in this repository. A Claude account's choices come from
 * the published fleet manifest; a Codex account's come from that account's own app-server, which is
 * the same list its picker is built from. A catalog that could not be read is a stated failure rather
 * than an empty success — the browser has a native-picker fallback for exactly this, and an empty
 * list would send the reader to it while implying the account genuinely offers nothing.
 *
 * WHY A BUSY PANE IS REFUSED RATHER THAN QUEUED. A runtime control is not a message: typing `/model`
 * behind an active turn would either be swallowed or arrive as conversation. The browser already
 * promises a refusal, and a queued control that silently applied three minutes later — to whatever
 * turn was running by then — is worse than being told to wait.
 */

/** Why a runtime read or control could not be served. */
export type SessionRuntimeFailure =
  /** The path or the request names something unusable. */
  | 'invalid'
  /** No such session. */
  | 'not_found'
  /** The session's own condition refuses it: a terminal status, a busy pane, a picker quarantine. */
  | 'refused'
  /** The harness cannot express what was asked — a level it has no command for, a model it does not
   *  advertise. A different request could succeed, which is what separates it from `refused`. */
  | 'unsupported'
  /** The live catalog could not be read, so no targeted switch can be planned against it. */
  | 'catalog_unavailable'
  /** The same request id was already spent on a DIFFERENT control. */
  | 'conflict'
  /**
   * The same request id already reached the harness, and how that attempt ended was never recorded.
   *
   * DISTINCT FROM `conflict`, because the caller did nothing wrong and there is nothing to correct in
   * the request. Repeating it is the danger — a second `/compact` discards context nobody asked to
   * lose — so the honest answer is "it happened; go and look" rather than a replayed success the
   * daemon cannot vouch for or a retry it must not perform.
   */
  | 'unsettled'
  /** It was attempted, and the attempt failed. */
  | 'failed';

/** A refusal raised by the composition root's runtime control, in a taxonomy `src/lib` may name. */
export class SessionRuntimeError extends Error {
  constructor(
    readonly failure: SessionRuntimeFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionRuntimeError';
  }
}

/** Reading and changing one running session's runtime settings. */
export interface SessionRuntimeSubsystem {
  /** What this session's account advertises it may be switched to, read live. */
  models(sessionId: string): Promise<RuntimeModelCatalog>;
  /**
   * Apply one control, and answer with the session as it stands afterwards.
   *
   * IDEMPOTENT ON `requestId`, which matters more here than on most mutations: a retried picker
   * drive would open a second modal on a pane the first one may still be inside. The same id
   * carrying a DIFFERENT control is a `conflict` rather than a replay — answering it with the first
   * control's session view would tell a caller its model switch succeeded when what actually
   * happened was somebody else's effort change.
   */
  control(sessionId: string, request: RuntimeControlRequest, requestId: string): Promise<SessionView>;
}

/** The HTTP status and code each refusal answers with. */
const REFUSALS: Readonly<Record<SessionRuntimeFailure, { readonly status: number; readonly code: string }>> = {
  invalid: { status: 400, code: 'invalid_request' },
  not_found: { status: 404, code: 'not-found' },
  refused: { status: 409, code: 'runtime_control_refused' },
  // `422`, not `400`: the request is well formed and the harness simply cannot express it, which is
  // what tells the browser to offer its native-picker escape hatch rather than to fix the body.
  unsupported: { status: 422, code: 'runtime_control_unsupported' },
  // `503`: the account has a catalog, and reading it did not work THIS TIME.
  catalog_unavailable: { status: 503, code: 'runtime_catalog_unavailable' },
  // The same code the start's retry contract answers with, because it is the same mistake: an id
  // that already means one operation cannot be made to mean a second one.
  conflict: { status: 409, code: 'request_id_reused' },
  // `409` as well: the request cannot be served AS ASKED and no retry of it will help. Its own code,
  // because "you reused an id" and "your id already happened" call for opposite reactions from the
  // caller — one is a bug in the client, the other is a session it should re-read.
  unsettled: { status: 409, code: 'runtime_control_unsettled' },
  failed: { status: 500, code: 'runtime_control_failed' },
};

/** Restates a runtime refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof SessionRuntimeError) {
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

/**
 * The idempotency key, REQUIRED rather than generated.
 *
 * The client already sends one on every runtime call, and it is the only thing standing between a
 * retry whose answer was lost and a second keystroke sequence typed into a live modal. A key the
 * daemon invented for itself would be idempotent against nothing.
 */
function requestId(context: RouteContext): string {
  const value = headerValue(context.request, FY_REQUEST_ID_HEADER)?.trim() ?? '';
  if (value === '')
    throw new ApiError(
      400,
      `a runtime control must carry ${FY_REQUEST_ID_HEADER}: without it a retried request drives the harness twice`,
      'missing_request_id',
    );
  return value;
}

/** What this session may be switched to, as its own account advertises it. */
async function models(subsystem: SessionRuntimeSubsystem, context: RouteContext): Promise<ApiResponse> {
  const catalog = await subsystem.models(pathSessionId(context)).catch(refuse);
  return jsonResponse(catalog);
}

/** Applies one control and answers with the session it changed. */
async function control(subsystem: SessionRuntimeSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const request = await parseBody(context.request, RuntimeControlRequestSchema);
  const view = await subsystem.control(sessionId, request, requestId(context)).catch(refuse);
  return jsonResponse(view);
}

/**
 * `operator` on both, matching every other route that reaches into a running session.
 *
 * NO CAPABILITY DEMAND, deliberately, and for the reason every other route into a running session
 * declares none. The capabilities an operator is asked about are enumerated once, by the protocol,
 * and changing which model a session the operator already controls is running is not among them.
 * Naming a new one here would put a second copy of the route table inside the grant document.
 *
 * `noStore` on both. The catalog is read LIVE from the account, and the control answers with a
 * session view whose status is exactly what the call just changed; a cached copy of either describes
 * a session that has already moved on.
 */
export function sessionRuntimeRoutes(subsystem: SessionRuntimeSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/runtime-models',
      minimum: 'operator',
      noStore: true,
      handle: async context => await models(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/runtime',
      minimum: 'operator',
      noStore: true,
      handle: async context => await control(subsystem, context),
    },
  ];
}
