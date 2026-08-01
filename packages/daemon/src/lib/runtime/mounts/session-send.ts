import {
  FY_REQUEST_ID_HEADER,
  InterruptSessionRequestSchema,
  SendRequestSchema,
  type SendResult,
  type SessionView,
} from '@ferretry/protocol';
import { PEER_ACTOR_PREFIX } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, headerValue, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/**
 * Talking to a session that is already running: `POST /v1/sessions/:sessionId/send` and
 * `POST /v1/sessions/:sessionId/interrupt`.
 *
 * THE DAEMON COULD NOT BE TOLD ANYTHING AFTER TURN ONE. The lifecycle delivers the first turn and the
 * revive replaces a dead pane; between them there was no verb at all, so `IFyApiClient.send` posted
 * here and got `unknown_route`. The consequences were not confined to a missing feature:
 *
 *   * A DECLARED WAIT ON A PEER COULD NEVER END. `SessionSignalService.park` resolves the session
 *     whose reply ends the wait, and that reply is a send. Every `--peer` park ran to its deadline no
 *     matter how promptly the peer answered, which made request/response between teammates a pattern
 *     the product declared and could not perform.
 *   * THREE CLI CONTROLLERS SHIPPED AGAINST A 404 — `send-controller.ts`, its `--ask` park, and
 *     `answer-controller.ts` — complete, tested, and calling nothing.
 *
 * WHAT IS STILL NOT HERE. `POST /v1/sessions/:id/answer` is NOT mounted, and that is a decision rather
 * than an omission: answering a structured question means driving the harness's own rendered form and
 * confirming the keys took, and nothing in this daemon ever writes a pending question in the first
 * place (the monitor loop that would is survey section F). A mounted `answer` would be a route that
 * could only ever refuse. The same reasoning bounds the interrupt below: it stops a turn, and it
 * declines to ABANDON a rendered question.
 *
 * WHY `admin` SCOPE, on both. The signal mount's header gives the full argument and it holds here
 * unchanged: the daemon cannot yet turn a per-session credential into "the caller IS session X", and
 * a route that trusted a session-scoped token to name its own subject would let any holder send into
 * any other session. The fleet wrappers hold the admin token, which is how a peer send works today —
 * and the SENDER is taken from the server-derived actor rather than the body, so a caller still
 * cannot claim to be somebody else.
 */

/** Why a send or an interrupt could not be acted on. */
export type SessionSendFailure =
  /** The id is not one the state-home layout would accept, or the request is otherwise unusable. */
  | 'invalid'
  /** No such session. */
  | 'not_found'
  /** The session's own condition refuses it: a quarantine, an unconfirmed kill, an open question. */
  | 'refused'
  /** A launch is still in flight. Pending rather than failed — the caller retries. */
  | 'pending'
  /** It was acted on, and the work it does — typing, reviving, journalling — failed. */
  | 'failed';

/** A refusal raised by the composition root's send handling, in a taxonomy `src/lib` may name. */
export class SessionSendError extends Error {
  constructor(
    readonly failure: SessionSendFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionSendError';
  }
}

/** Talking to one running session. Both requests are the parsed wire shapes, unchanged. */
export interface SessionSendSubsystem {
  send(sessionId: string, request: SendInput): Promise<SendResult>;
  interrupt(sessionId: string): Promise<SessionView>;
}

/** A send as the route hands it over: the client's body, plus the two facts only the route knows. */
export interface SendInput {
  readonly message: string;
  readonly attachmentIds?: readonly string[] | undefined;
  readonly now?: boolean | undefined;
  readonly replyExpected?: boolean | undefined;
  /** The caller's own idempotency key, from the request-id header. */
  readonly sendId: string;
  /** The SESSION that made this call, derived from the credential — never from the body. */
  readonly senderSessionId?: string | undefined;
}

/** The HTTP status and code each refusal answers with. */
const REFUSALS: Readonly<Record<SessionSendFailure, { readonly status: number; readonly code: string }>> = {
  invalid: { status: 400, code: 'invalid_request' },
  not_found: { status: 404, code: 'not-found' },
  refused: { status: 409, code: 'send_refused' },
  // `503`, not `409`: the session is not refusing, it is not ready yet, and the difference is exactly
  // what tells a caller to retry rather than to change what they asked for.
  pending: { status: 503, code: 'session_launching' },
  failed: { status: 500, code: 'session_send_failed' },
};

/** Restates a send refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof SessionSendError) {
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
 * A send the daemon keyed by an id it invented itself would be idempotent against nothing: the whole
 * protection is that the CLIENT sends the same key on a retry, so a request whose answer was lost in
 * transit does not become a second message the agent reads and acts on twice. The client already
 * sends this header on every request.
 */
function sendId(context: RouteContext): string {
  const value = headerValue(context.request, FY_REQUEST_ID_HEADER)?.trim() ?? '';
  if (value === '')
    throw new ApiError(
      400,
      `a send must carry ${FY_REQUEST_ID_HEADER}: without it a retried request becomes a second message`,
      'missing_request_id',
    );
  return value;
}

/**
 * The session that made this call, when a teammate did rather than a person.
 *
 * Taken from the actor the authorization boundary derived, never from the body. `from` decides two
 * things that matter — how the message is attributed to the receiver, and whose declared wait it
 * ends — and a caller able to name itself could end any other session's park.
 */
function senderSessionId(context: RouteContext): string | undefined {
  const actor = context.actor ?? '';
  return actor.startsWith(PEER_ACTOR_PREFIX) ? actor.slice(PEER_ACTOR_PREFIX.length) : undefined;
}

/** Hands a running session its next turn. */
async function send(subsystem: SessionSendSubsystem, context: RouteContext): Promise<ApiResponse> {
  const id = pathSessionId(context);
  const request = await parseBody(context.request, SendRequestSchema);
  const sender = senderSessionId(context);
  const result = await subsystem
    .send(id, {
      message: request.message,
      sendId: sendId(context),
      ...(request.attachmentIds === undefined ? {} : { attachmentIds: request.attachmentIds }),
      ...(request.now === undefined ? {} : { now: request.now }),
      ...(request.replyExpected === undefined ? {} : { replyExpected: request.replyExpected }),
      ...(sender === undefined ? {} : { senderSessionId: sender }),
    })
    .catch(refuse);
  return jsonResponse(result);
}

/**
 * Stops the current turn.
 *
 * The body is parsed even though every field in it is optional, because `toolUseId` is not: a client
 * that names the question it means to abandon is asking for the bound-abandon path, and answering it
 * with a plain turn-stop would report success for an operation that never happened. It is refused
 * with the reason, which the header explains.
 */
async function interrupt(subsystem: SessionSendSubsystem, context: RouteContext): Promise<ApiResponse> {
  const id = pathSessionId(context);
  const request = await parseBody(context.request, InterruptSessionRequestSchema);
  if (request.toolUseId !== undefined)
    throw new ApiError(
      501,
      `abandoning structured question ${request.toolUseId} is not served: cancelling a rendered ` +
        'question means positively re-binding THAT question on the terminal before releasing it, and ' +
        'this daemon has no pane matchers, so it cannot tell the question you named from one that ' +
        'appeared afterwards — releasing the wrong overlay is worse than refusing',
      'question_abandon_unsupported',
    );
  const view = await subsystem.interrupt(id).catch(refuse);
  return jsonResponse(view);
}

/**
 * `admin` scope — see the header for why a session cannot yet sign for itself.
 *
 * `noStore` because both answers are a live session view whose status is exactly what the call
 * changed; a cached one shows the session as it was before the turn started or stopped.
 */
export function sessionSendRoutes(subsystem: SessionSendSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/send',
      scope: 'admin',
      noStore: true,
      handle: async context => await send(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/interrupt',
      scope: 'admin',
      noStore: true,
      handle: async context => await interrupt(subsystem, context),
    },
  ];
}
