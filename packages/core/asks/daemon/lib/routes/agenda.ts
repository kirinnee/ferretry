import {
  AgendaConversationPageSchema,
  AgendaConversationQuerySchema,
  type AgendaSeenResponse,
  AgendaSeenRequestSchema,
  type AgendaVersionList,
} from '../protocol/agenda-versions.ts';
import {
  type AgendaActionRequest,
  AgendaActionRequestSchema,
  AgendaIdSchema,
  type AgendaErrorCode,
  type AgendaSnapshot,
  isMachineAgendaId,
  readsAgendaHeaders,
} from '../protocol/agenda.ts';
import { agendaListSnapshot } from '../protocol/agenda-list.ts';
import { type ApiActor, isHumanAdminActor, parseActor } from '@ferretry/core-gate/contract';
import {
  ApiError,
  type ApiResponse,
  type CallContext,
  decodeParameter,
  jsonResponse,
  queryValue,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { parseBody } from './body.ts';
import {
  type AgendaActor,
  type AgendaFailure,
  type AgendaRepliesSubsystem,
  type AgendaService,
  type EditAgendaPatch,
  isAgendaSessionId,
  lintAgendaWriting,
} from '../agenda/index.ts';
import { type AgendaConfigPort, answerConfirmation, raiseRequestOf } from './agenda-confirms.ts';
import { type AgendaGatePort, answerGate, cardAnswerPermission, refuseGateDismissal } from './agenda-gates.ts';
import type { SourceAnswer } from './agenda-gates.ts';
import type { AgendaMutation } from '../agenda/index.ts';

type SourceAnswers = (answer: SourceAnswer) => Promise<AgendaMutation | undefined>;

/**
 * The agenda board's HTTP surface: what a session is blocked on, and the human's answer to it.
 *
 * This is the route table the CLI's `ProtocolAgendaGateway` speaks — `GET` and `POST` on
 * `/v1/sessions/:sessionId/agenda` — so mounting it is what makes the shipped `fy agenda`,
 * `fy answer` and `fy resolve` commands work.
 */

export interface DirectNotificationSubsystem {
  /** How many devices are enrolled for push on this machine right now. */
  enrolledDevices(): Promise<number>;
}

/**
 * How each domain refusal is reported.
 *
 * `corrupt` is the one that is not the caller's fault: an unreadable ledger is the daemon's data
 * problem, and reporting it as a 4xx would send an operator auditing their own request. `full` and
 * `read-only` are conflicts rather than bad requests — the request was well-formed and the board's
 * current state is what refused it.
 */
const AGENDA_ERROR_STATUS: Readonly<Record<AgendaErrorCode, number>> = {
  invalid: 400,
  'too-long': 400,
  'not-found': 404,
  forbidden: 403,
  'rate-limited': 429,
  'read-only': 409,
  full: 409,
  corrupt: 500,
  use_input_form: 400,
  ask_changed: 409,
  stale: 409,
};

/**
 * Who the board thinks is acting, derived from the actor the authorization boundary resolved.
 *
 * An authenticated in-pane caller attributed as a peer is an agent; host-admin and registry-resolved
 * device actors are the human. Any other value is refused: unrecognised provenance must never inherit
 * the human's ability to dismiss every item. The session id comes from request-level actor attribution,
 * not the mutation body. Because that attribution is a client-set header under the shared admin token,
 * the service and state-machine guards below constrain it to the target session. A display name is not
 * carried by the API actor, so it is honestly `null` rather than guessed.
 */
export function agendaActor(actor: ApiActor | undefined): AgendaActor {
  const { kind, id } = parseActor(actor ?? '');
  if (kind === 'ferret' && id !== undefined && isAgendaSessionId(id)) {
    return { kind: 'agent', sessionId: id, name: null };
  }
  // Host admin actors and a registry-resolved paired device are the two human
  // forms this route can receive. Everything else is unavailable provenance,
  // never a benign default to human authority.
  if (isHumanAdminActor(actor) || (kind === 'device' && id !== undefined && id.trim() !== '')) {
    return { kind: 'human' };
  }
  throw new ApiError(403, 'agenda mutations require established human or session provenance', 'forbidden');
}

/** Turns a domain refusal into its HTTP answer, keeping the domain's own code for the client. */
function refusal(error: AgendaFailure): never {
  throw new ApiError(AGENDA_ERROR_STATUS[error.code], error.message, error.code);
}

/** The path's session id, decoded. `decodeParameter` refuses a traversal or a separator, so a
 *  crafted id can never address a ledger outside the session tree. */
function pathSessionId(context: Call): string {
  const decoded = decodeParameter(context.params.get('ferretId') ?? '');
  if (decoded === undefined) throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_session_id');
  if (isMachineAgendaId(decoded))
    throw new ApiError(404, 'the machine agenda is available only at /v1/machine/agenda', 'not-found');
  return decoded;
}

type HeldReplies = Pick<AgendaRepliesSubsystem, 'pending' | 'delivery'>;

/** List projection is opt-in: only a reader that names channel 2 gets resolved headers on list reads. */
const servedAgendaListSnapshot = (context: Call, snapshot: AgendaSnapshot) =>
  readsAgendaHeaders(context.request.headers) ? agendaListSnapshot(snapshot) : snapshot;

/**
 * The board with the answers this machine is holding for the ferret (`replies`) and the ones on their way
 * but not yet proven to arrive (`delivery`), so the owner's screen can say "Sending…". An outbox that
 * cannot be read is left off: the board is the answer.
 */
async function withReplies(replies: HeldReplies, sessionId: string, snapshot: AgendaSnapshot): Promise<AgendaSnapshot> {
  const [held, delivery] = await Promise.all([
    replies.pending(sessionId).catch(() => undefined),
    replies.delivery(sessionId).catch(() => undefined),
  ]);
  return {
    ...snapshot,
    ...(held === undefined ? {} : { replies: held }),
    ...(delivery === undefined ? {} : { delivery }),
  };
}

async function list(agenda: AgendaService, replies: HeldReplies, context: Call): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const result = await agenda.list(sessionId);
  return result.ok
    ? jsonResponse(servedAgendaListSnapshot(context, await withReplies(replies, sessionId, result.value)))
    : refusal(result.error);
}

/**
 * "Send now": the owner skips the settle window and the held answers go to the ferret at once. The board
 * is read first, so an unknown session is refused rather than given an outbox. Answers the board with
 * nothing left held; the send itself is detached, exactly as the timer's is.
 */
async function sendReplies(
  agenda: AgendaService,
  replies: AgendaRepliesSubsystem,
  context: Call,
): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const before = await agenda.list(sessionId);
  if (!before.ok) return refusal(before.error);
  await replies.sendNow(sessionId);
  return jsonResponse(await withReplies(replies, sessionId, before.value));
}

/** The item id in the path, or a 400: the same grammar the board uses. */
function pathItemId(context: Call): string {
  const parsed = AgendaIdSchema.safeParse(decodeParameter(context.params.get('id') ?? ''));
  if (!parsed.success) throw new ApiError(400, 'the item id in the path is not an agenda id', 'invalid');
  return parsed.data;
}

/** Which device is asking: a paired device by its id, and the owner at the host by one name for all of its tools. */
const deviceOf = (context: Call): string =>
  context.credential?.tokenClass === 'device' ? String(context.credential.principal.holder) : 'host';

/** `GET …/agenda/:id/versions`: every version kept of an item, oldest first, and this device's last seen. */
async function listVersions(agenda: AgendaService, context: Call): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const id = pathItemId(context);
  const result = await agenda.versionsOf(sessionId, id, deviceOf(context));
  if (!result.ok) return refusal(result.error);
  const { versions, seen } = result.value;
  const body: AgendaVersionList = {
    sessionId,
    id,
    latest: versions.at(-1)?.version ?? 0,
    ...(seen === undefined ? {} : { seen }),
    versions: [...versions],
  };
  return jsonResponse(body);
}

/** `GET …/agenda/:id/versions/:version`: one version of an item in full. */
async function getVersion(agenda: AgendaService, context: Call): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const id = pathItemId(context);
  const version = Number(decodeParameter(context.params.get('version') ?? ''));
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ApiError(400, 'the version in the path is not a version number', 'invalid');
  }
  const result = await agenda.versionOf(sessionId, id, version);
  return result.ok ? jsonResponse(result.value) : refusal(result.error);
}

/** `PUT …/agenda/:id/seen`: this device opened the item at this version. */
async function markSeen(agenda: AgendaService, context: Call): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const id = pathItemId(context);
  const { version } = await parseBody(context.request, AgendaSeenRequestSchema);
  const result = await agenda.markSeen(sessionId, id, version, deviceOf(context));
  if (!result.ok) return refusal(result.error);
  const body: AgendaSeenResponse = { seen: result.value };
  return jsonResponse(body);
}

/**
 * Applies one board action.
 *
 * `resolve` carrying a `response` is an ANSWER — the human chose one of the options the agent
 * offered — and `resolve` without one is the human closing the item out. The source conflated the
 * two into a single write that recorded no answer at all, so an agent waiting on a choice was
 * unblocked with nothing to read.
 */
async function apply(
  agenda: AgendaService,
  notifications: DirectNotificationSubsystem | undefined,
  replies: HeldReplies,
  config: AgendaConfigPort | undefined,
  gates: AgendaGatePort | undefined,
  context: Call,
  sources?: SourceAnswers,
): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const request = await parseBody(context.request, AgendaActionRequestSchema);
  const actor = agendaActor(context.actor);
  if (
    request.action === 'resolve' &&
    request.attachments !== undefined &&
    request.cardAsk === undefined &&
    request.gate !== true
  )
    throw new ApiError(400, 'files can only come with the answer to a card ask', 'invalid');
  const sourced =
    request.action === 'resolve' && sources !== undefined
      ? await sources({
          sessionId,
          id: request.id,
          response: request.response,
          note: request.note,
          actor,
          cardAsk: request.cardAsk,
          gate: request.gate,
          permitted: () => cardAnswerPermission(context),
          askVersion: request.askVersion,
          ...(context.credential?.tokenClass === 'device'
            ? { holder: String(context.credential.principal.holder) }
            : {}),
        })
      : undefined;
  // An answer to a card's gate moves the card first; only a move that went through answers the item.
  const gated =
    sourced === undefined && request.action === 'resolve' && request.response !== undefined && gates !== undefined
      ? await answerGate(gates, context, {
          sessionId,
          id: request.id,
          response: request.response,
          note: request.note,
          actor,
          cardAsk: request.cardAsk,
          gate: request.gate,
          askVersion: request.askVersion,
          attachments: request.attachments,
        })
      : undefined;
  // Files belong to a card's gate answer: an answer that is not one has nothing to carry them to.
  if (request.action === 'resolve' && request.attachments !== undefined && gated === undefined) {
    throw new ApiError(400, 'files can only come with the answer to a card ask', 'invalid');
  }
  // Not needed on a gate item asks the same grant an answer does.
  if (request.action === 'dismiss' && gates !== undefined) {
    await refuseGateDismissal(gates, context, { sessionId, id: request.id, actor });
  }
  // An answer to an item that confirms a held configuration change acts on the change first.
  const confirmed =
    request.action === 'resolve' && request.response !== undefined && config !== undefined
      ? await answerConfirmation(agenda, config, context, {
          sessionId,
          id: request.id,
          response: request.response,
          note: request.note,
          actor,
        })
      : undefined;
  if (confirmed?.proceed === false) return confirmed.response;
  const mutation = await (sourced !== undefined
    ? sourced
    : gated !== undefined
      ? gated
      : request.action === 'add'
        ? agenda.raise(sessionId, await raiseRequestOf(request, config), actor)
        : request.action === 'edit'
          ? agenda.edit(sessionId, request.id, editPatch(request), actor, request.now === true)
          : request.action === 'progress'
            ? agenda.progress(sessionId, request.id, request.step, request.done, actor)
            : request.action === 'needs-info'
              ? agenda.needsInfo(sessionId, request.id, actor, request.note)
              : request.action === 'discuss'
                ? agenda.discuss(sessionId, request.id, actor, request.note)
                : request.action === 'surface'
                  ? agenda.surface(sessionId, request.id, actor, request.why, request.now === true)
                  : request.action === 'rest'
                    ? agenda.rest(sessionId, request.id, request.why, actor)
                    : request.action === 'log'
                      ? agenda.log(sessionId, request.id, request.mode, request.text, actor, request.messageId)
                      : request.action === 'merge'
                        ? agenda.merge(sessionId, request.id, request.from, actor)
                        : request.action === 'split'
                          ? agenda.split(
                              sessionId,
                              request.id,
                              { source: 'agent-raised', sourceRef: null, ...request.item },
                              actor,
                              request.moveCards,
                            )
                          : request.action === 'snooze'
                            ? agenda.snooze(sessionId, request.id, request.until, actor)
                            : request.action === 'unsnooze'
                              ? agenda.unsnooze(sessionId, request.id, actor)
                              : request.action === 'dismiss'
                                ? agenda.dismiss(sessionId, request.id, actor, request.note, request.askVersion)
                                : request.response === undefined
                                  ? agenda.resolve(
                                      sessionId,
                                      request.id,
                                      actor,
                                      request.note,
                                      'board',
                                      request.askVersion,
                                    )
                                  : agenda.answer(
                                      sessionId,
                                      request.id,
                                      request.response,
                                      actor,
                                      confirmed?.note ?? request.note,
                                      'board',
                                      undefined,
                                      request.askVersion,
                                    ));
  if (!mutation.ok) return refusal(mutation.error);
  const written =
    mutation.change === 'created' ||
    mutation.change === 'split' ||
    mutation.change === 'refreshed' ||
    mutation.change === 'info-added';
  const warnings = written && mutation.item !== undefined ? lintAgendaWriting(mutation.item) : [];
  const notes = mutation.notes ?? [];
  const enrolled = mutation.change === 'created' ? await enrolledDevices(notifications) : undefined;
  return jsonResponse({
    ...(await withReplies(replies, sessionId, mutation.snapshot)),
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(notes.length === 0 ? {} : { notes: [...notes] }),
    ...(enrolled === undefined ? {} : { enrolled }),
  });
}

/**
 * How many devices the push that a raise just made could reach, for the raiser to be told when it is none.
 * Undefined when the push store cannot be read: the item is raised either way, and a count nobody can
 * vouch for is no count at all.
 */
async function enrolledDevices(notifications: DirectNotificationSubsystem | undefined): Promise<number | undefined> {
  return await notifications?.enrolledDevices().catch(() => undefined);
}

/** The fields an edit request names, with the ones it leaves out left out. */
function editPatch(request: Extract<AgendaActionRequest, { action: 'edit' }>): EditAgendaPatch {
  const { action: _action, id: _id, now: _now, ...patch } = request;
  return patch;
}

/** One call to an agenda route: the request, its params, and the standing Gate put on it. */
type Call = CallContext;

/**
 * The ferret agenda's route handlers, keyed as the manifest declares them (descriptors copied from today's
 * `agendaRoutes`: `operator` minimum, `noStore`, the item reads and the answer open to `any` caller, the seen mark
 * and Send now to a `person`). `/v1/sessions/:sessionId/agenda…` moved to `/v1/ferrets/:ferretId/agenda…` (§1.4).
 *
 * `noStore` because an agenda board is the thing a human is watching to know whether a ferret is waiting on them; a
 * cached one shows a question that has already been answered.
 */
export function agendaRoutes(
  agenda: AgendaService,
  replies: AgendaRepliesSubsystem,
  /** How many devices a raise's push could reach; absent, a raise says nothing about it. */
  notifications?: DirectNotificationSubsystem,
  /** The held configuration edits an item may confirm; absent, `--confirms` is refused. */
  config?: AgendaConfigPort,
  /** The card asks an answer may move a card through; absent, a card ask is answered like any other choice. */
  gates?: AgendaGatePort,
  sources?: SourceAnswers,
) {
  // Every ferret agenda route passes here, including future item reads. Refuse the reserved ledger before parsing
  // a body or cursor, consulting gates, delivering replies, or touching any service.
  const guarded =
    (handle: (call: Call) => Promise<ApiResponse>): RouteHandler =>
    async call => {
      pathSessionId(call);
      return await handle(call);
    };
  return {
    'GET /v1/ferrets/:ferretId/agenda/:id': guarded(async call => {
      const result = await agenda.list(pathSessionId(call));
      if (!result.ok) return refusal(result.error);
      const snapshot = result.value;
      const id = pathItemId(call);
      const item = snapshot.items.find(item => item.id === id) ?? snapshot.resolved.find(item => item.id === id);
      if (item === undefined) throw new ApiError(404, 'agenda item not found', 'not-found');
      return jsonResponse(item);
    }),
    'GET /v1/ferrets/:ferretId/agenda': guarded(async call => await list(agenda, replies, call)),
    'POST /v1/ferrets/:ferretId/agenda': guarded(
      async call => await apply(agenda, notifications, replies, config, gates, call, sources),
    ),
    'GET /v1/ferrets/:ferretId/agenda/:id/conversation': guarded(async call => {
      const query = AgendaConversationQuerySchema.safeParse({
        index: queryValue(call.request, 'index'),
        offset: queryValue(call.request, 'offset'),
        version: queryValue(call.request, 'version'),
      });
      if (!query.success)
        throw new ApiError(400, 'conversation cursor must use nonnegative integers and a positive version', 'invalid');
      const result = await agenda.conversationOf(
        pathSessionId(call),
        pathItemId(call),
        query.data.index,
        query.data.offset,
        query.data.version,
      );
      return result.ok ? jsonResponse(AgendaConversationPageSchema.parse(result.value)) : refusal(result.error);
    }),
    'GET /v1/ferrets/:ferretId/agenda/:id/versions': guarded(async call => await listVersions(agenda, call)),
    'GET /v1/ferrets/:ferretId/agenda/:id/versions/:version': guarded(async call => await getVersion(agenda, call)),
    'PUT /v1/ferrets/:ferretId/agenda/:id/seen': guarded(async call => await markSeen(agenda, call)),
    'POST /v1/ferrets/:ferretId/agenda/replies': guarded(async call => await sendReplies(agenda, replies, call)),
  } as const;
}
