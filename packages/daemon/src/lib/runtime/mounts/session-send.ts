import {
  COMPOSER_OCCUPIED_CODE,
  type ComposerDraftRequest,
  ComposerDraftRequestSchema,
  type ComposerDraftResult,
  FY_REQUEST_ID_HEADER,
  InterruptSessionRequestSchema,
  SEND_UNCONFIRMED_CODE,
  SendCancelRequestSchema,
  type SendRecord,
  SendRequestSchema,
  type SendResult,
  SendRetryRequestSchema,
  SendSubmitRequestSchema,
  type QueuedMessage,
  QueueEditRequestSchema,
  type SessionHandoff,
  SessionHandoffNameSchema,
  type SessionView,
} from '@ferretry/protocol';
import { PEER_ACTOR_PREFIX } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter, headerValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { DEFAULT_SEND_PAGE, MAX_SEND_PAGE, type SendPageQuery, sendPage } from '../../session/send/page.ts';

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
 * WHO SENDS. The SENDER is the server-derived actor, never the body: a ferret's own session credential
 * makes it `peer:<that session>` whatever any header says (`caller: 'any'`), and the admin token plus
 * `x-ferretry-session-id` is the older honest-client form of the same. Being a ferret buys a SENDER
 * identity, never a different TARGET's: the path names where the message goes, as for every caller.
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
  /**
   * It was typed into the agent's composer and nothing proved it landed. Neither refused nor failed:
   * answered as `send_unconfirmed` with the send's id, so the app can act on exactly that send.
   */
  | 'unconfirmed'
  /** It was acted on, and the work it does — typing, reviving, journalling — failed. */
  | 'failed';

/** A refusal raised by the composition root's send handling, in a taxonomy `src/lib` may name. */
export class SessionSendError extends Error {
  constructor(
    readonly failure: SessionSendFailure,
    message: string,
    /**
     * The person's own text the agent's composer is holding, when that is why the send was refused:
     * answered as `composer_occupied` with this draft, so the app can offer to send or clear it.
     */
    readonly draft?: string,
    /** The send an `unconfirmed` answer is about. */
    readonly sendId?: string,
  ) {
    super(message);
    this.name = 'SessionSendError';
  }
}

/** Talking to one running session. Both requests are the parsed wire shapes, unchanged. */
export interface SessionSendSubsystem {
  send(sessionId: string, request: SendInput): Promise<SendResult>;
  interrupt(sessionId: string): Promise<SessionView>;
  /** Every send this session's ledger holds, newest first, each with the fate proven so far. */
  sends(sessionId: string): Promise<readonly SendRecord[]>;
  /** One send by its id — how a sender learns where its message settled. */
  sendStatus(sessionId: string, sendId: string): Promise<SendRecord>;
  /** Every message the session's durable queue holds, oldest first (`lib/session/queue`). */
  queue(sessionId: string): Promise<readonly QueuedMessage[]>;
  /** New words for a queued message that is still waiting; refused once a key has gone to the pane. */
  editQueued(sessionId: string, messageId: string, text: string): Promise<QueuedMessage>;
  /** Takes back a queued message that is still waiting; nothing of it was ever typed. */
  cancelQueued(sessionId: string, messageId: string): Promise<QueuedMessage>;
  /** Re-attempts one send under its original id, as a person asked. */
  retry(sessionId: string, sendId: string, force: boolean): Promise<SendRecord>;
  /** Takes back one send not proven delivered, erasing it from the composer when it is typed there. */
  cancel(sessionId: string, sendId: string): Promise<SendRecord>;
  /** Presses Enter once for a send sitting typed, and not sent, in the agent's composer. */
  submit(sessionId: string, sendId: string): Promise<SendRecord>;
  /** Presses Enter on, or erases, the person's own draft — only while the composer holds exactly it. */
  composer(sessionId: string, request: ComposerDraftRequest): Promise<ComposerDraftResult>;
  /** What the person sent in one hand-off document (`turn-008`, `queued-<send id>`). */
  handoff(sessionId: string, name: string): Promise<SessionHandoff>;
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
  // `409` like a refusal, because the caller's next move is a decision about THIS send — press Enter on
  // it, clear it, retry it — and never a blind re-post, which is what a `5xx` invites.
  unconfirmed: { status: 409, code: SEND_UNCONFIRMED_CODE },
  failed: { status: 500, code: 'session_send_failed' },
};

/** Restates a send refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof SessionSendError) {
    // The person's draft rides in the body so the app can act on exactly that text; the message alone
    // quotes only its start.
    if (error.failure === 'refused' && error.draft !== undefined)
      throw new ApiError(409, error.message, COMPOSER_OCCUPIED_CODE, undefined, { draft: error.draft });
    if (error.failure === 'unconfirmed' && error.sendId !== undefined)
      throw new ApiError(409, error.message, SEND_UNCONFIRMED_CODE, undefined, { sendId: error.sendId });
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
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await send(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/interrupt',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await interrupt(subsystem, context),
    },
    ...sendLedgerRoutes(subsystem),
  ];
}

/** The send id in the path, decoded. */
function pathSendId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sendId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the send id in the path is not usable', 'invalid_send_id');
  return decoded;
}

/** The queued message id in the path, decoded. */
function pathMessageId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('messageId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the message id in the path is not usable', 'invalid_message_id');
  return decoded;
}

/** The page a sends read asks for: `limit` (1 to {@link MAX_SEND_PAGE}) and `before`, the cursor a previous page named. */
function sendPageQuery(context: RouteContext): SendPageQuery {
  const { query } = context.request;
  for (const [name] of query) {
    if (name !== 'limit' && name !== 'before')
      throw new ApiError(400, `unknown sends parameter ${name}`, 'unknown_parameter');
  }
  const raw = query.get('limit')?.[0];
  const limit = raw === undefined ? DEFAULT_SEND_PAGE : Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEND_PAGE)
    throw new ApiError(400, `a sends limit must be a whole number from 1 to ${MAX_SEND_PAGE}`, 'invalid_limit');
  const before = query.get('before')?.[0];
  if (before === '') throw new ApiError(400, 'a sends cursor must not be empty', 'invalid_cursor');
  return before === undefined ? { limit } : { limit, before };
}

/** One page of a session's sends, or the refusal of a cursor that names none of them. */
async function sendsPage(subsystem: SessionSendSubsystem, context: RouteContext): Promise<ApiResponse> {
  const query = sendPageQuery(context);
  const page = sendPage(await subsystem.sends(pathSessionId(context)).catch(refuse), query);
  if (page === undefined) throw new ApiError(400, `no send ${query.before ?? ''} to page from`, 'invalid_cursor');
  return jsonResponse(page);
}

/**
 * `operator` minimum on the three ledger routes, for the reason the send itself carries it: a send
 * row is the message text, and a retry types it into a live terminal again.
 *
 * `noStore` because every answer is a fate that may change on the next look.
 */
function sendLedgerRoutes(subsystem: SessionSendSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/sends',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      // A page, not the whole ledger (`session/send/page.ts`): the newest sends and every open one.
      handle: async context => await sendsPage(subsystem, context),
    },
    // The durable queue every message will go through. Read-only until delivery moves onto it, and the
    // same words as the ledger rows above, so the same minimum.
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/queue',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => jsonResponse({ messages: await subsystem.queue(pathSessionId(context)).catch(refuse) }),
    },
    // Editing or taking back a message only while it waits: the words are the sender's until a key goes
    // to the pane, and the agent's after. Governed as the send itself is.
    {
      method: 'PATCH',
      path: '/v1/sessions/:sessionId/queue/:messageId',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => {
        const id = pathSessionId(context);
        const messageId = pathMessageId(context);
        const request = await parseBody(context.request, QueueEditRequestSchema);
        return jsonResponse(await subsystem.editQueued(id, messageId, request.text).catch(refuse));
      },
    },
    {
      method: 'DELETE',
      path: '/v1/sessions/:sessionId/queue/:messageId',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context =>
        jsonResponse(await subsystem.cancelQueued(pathSessionId(context), pathMessageId(context)).catch(refuse)),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/sends/:sendId',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context =>
        jsonResponse(await subsystem.sendStatus(pathSessionId(context), pathSendId(context)).catch(refuse)),
    },
    // The message behind a pointer the transcript records. It is the same words the send row above
    // carries — the turn document is where a send writes them — so it takes the same minimum.
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/handoffs/:name',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => {
        const name = SessionHandoffNameSchema.safeParse(decodeParameter(context.params.get('name') ?? ''));
        if (!name.success) throw new ApiError(400, 'the hand-off name in the path is not usable', 'invalid_handoff');
        return jsonResponse(await subsystem.handoff(pathSessionId(context), name.data).catch(refuse));
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/sends/:sendId/retry',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => {
        const id = pathSessionId(context);
        const sendId = pathSendId(context);
        const request = await parseBody(context.request, SendRetryRequestSchema);
        return jsonResponse(await subsystem.retry(id, sendId, request.force === true).catch(refuse));
      },
    },
    // Cancel and Enter finish or take back a send, so they are governed exactly as the send and its
    // retry are: `operator`, no capability of their own. Each touches only the composer, and only
    // when it holds exactly that send's text — the service refuses anything else.
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/sends/:sendId/cancel',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => {
        const id = pathSessionId(context);
        const sendId = pathSendId(context);
        await parseBody(context.request, SendCancelRequestSchema);
        return jsonResponse(await subsystem.cancel(id, sendId).catch(refuse));
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/sends/:sendId/enter',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => {
        const id = pathSessionId(context);
        const sendId = pathSendId(context);
        await parseBody(context.request, SendSubmitRequestSchema);
        return jsonResponse(await subsystem.submit(id, sendId).catch(refuse));
      },
    },
    // The person's own draft is not a send: no ledger row is behind it, and Enter or an erase is a key
    // into the agent's pane on text Ferretry did not type. So it is governed as every other key into
    // that pane is — `terminal.use` (docs/grants.md) — and audited as `terminal.input`, never with
    // the text. The service acts only while the composer still holds exactly `draft`.
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/composer',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => {
        const id = pathSessionId(context);
        const request = await parseBody(context.request, ComposerDraftRequestSchema);
        return jsonResponse(await subsystem.composer(id, request).catch(refuse));
      },
    },
  ];
}
