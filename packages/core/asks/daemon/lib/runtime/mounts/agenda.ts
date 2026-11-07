import {
  AgendaConversationPageSchema,
  AgendaConversationQuerySchema,
  type AgendaSeenResponse,
  AgendaSeenRequestSchema,
  type AgendaVersionList,
} from '../../protocol/agenda-versions.ts';
import {
  type AgendaActionRequest,
  AgendaActionRequestSchema,
  AgendaIdSchema,
  type AgendaErrorCode,
  type AgendaSnapshot,
  isMachineAgendaId,
  readsAgendaHeaders,
} from '../../protocol/agenda.ts';
import { agendaListSnapshot } from '../../protocol/agenda-list.ts';
import { type ApiActor, isHumanAdminActor, parseActor } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter, queryValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import {
  type AgendaActor,
  type AgendaFailure,
  type AgendaRepliesSubsystem,
  type AgendaService,
  type EditAgendaPatch,
  isAgendaSessionId,
  lintAgendaWriting,
} from '../../agenda/index.ts';
import { type AgendaConfigPort, answerConfirmation, raiseRequestOf } from './agenda-confirms.ts';
import { type AgendaGatePort, answerGate, refuseGateDismissal } from './agenda-gates.ts';

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
  if (kind === 'peer' && id !== undefined && isAgendaSessionId(id)) {
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
function pathSessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined) throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  if (isMachineAgendaId(decoded))
    throw new ApiError(404, 'the machine agenda is available only at /v1/machine/agenda', 'not-found');
  return decoded;
}

type HeldReplies = Pick<AgendaRepliesSubsystem, 'pending' | 'delivery'>;

/** List projection is opt-in: only a reader that names channel 2 gets resolved headers on list reads. */
export const servedAgendaListSnapshot = (context: RouteContext, snapshot: AgendaSnapshot) =>
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

async function list(agenda: AgendaService, replies: HeldReplies, context: RouteContext): Promise<ApiResponse> {
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
  context: RouteContext,
): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const before = await agenda.list(sessionId);
  if (!before.ok) return refusal(before.error);
  await replies.sendNow(sessionId);
  return jsonResponse(await withReplies(replies, sessionId, before.value));
}

/** The item id in the path, or a 400: the same grammar the board uses. */
export function pathItemId(context: RouteContext): string {
  const parsed = AgendaIdSchema.safeParse(decodeParameter(context.params.get('id') ?? ''));
  if (!parsed.success) throw new ApiError(400, 'the item id in the path is not an agenda id', 'invalid');
  return parsed.data;
}

/** Which device is asking: a paired device by its id, and the owner at the host by one name for all of its tools. */
const deviceOf = (context: RouteContext): string =>
  context.credential?.tokenClass === 'device' ? context.credential.deviceId : 'host';

/** `GET …/agenda/:id/versions`: every version kept of an item, oldest first, and this device's last seen. */
async function listVersions(agenda: AgendaService, context: RouteContext): Promise<ApiResponse> {
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
async function getVersion(agenda: AgendaService, context: RouteContext): Promise<ApiResponse> {
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
async function markSeen(agenda: AgendaService, context: RouteContext): Promise<ApiResponse> {
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
  notifications: Pick<DirectNotificationSubsystem, 'enrolledDevices'>,
  replies: HeldReplies,
  config: AgendaConfigPort | undefined,
  gates: AgendaGatePort | undefined,
  context: RouteContext,
): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const request = await parseBody(context.request, AgendaActionRequestSchema);
  const actor = agendaActor(context.actor);
  // An answer to a card's gate moves the card first; only a move that went through answers the item.
  const gated =
    request.action === 'resolve' && request.response !== undefined && gates !== undefined
      ? await answerGate(gates, context, {
          sessionId,
          id: request.id,
          response: request.response,
          note: request.note,
          actor,
          gate: request.gate,
          cardAsk: request.cardAsk,
          askVersion: request.askVersion,
          attachments: request.attachments,
        })
      : undefined;
  // Files belong to a card's gate answer: an answer that is not one has nothing to carry them to.
  if (request.action === 'resolve' && request.attachments !== undefined && gated === undefined) {
    throw new ApiError(400, 'files can only come with the answer to a try-it or an approval', 'invalid');
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
  const mutation = await (gated !== undefined
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
async function enrolledDevices(
  notifications: Pick<DirectNotificationSubsystem, 'enrolledDevices'>,
): Promise<number | undefined> {
  return await notifications.enrolledDevices().catch(() => undefined);
}

/** The fields an edit request names, with the ones it leaves out left out. */
function editPatch(request: Extract<AgendaActionRequest, { action: 'edit' }>): EditAgendaPatch {
  const { action: _action, id: _id, now: _now, ...patch } = request;
  return patch;
}

/**
 * `admin` scope on both, which is the conservative reading of a surface a warden can currently only
 * reach through the daemon's own trusted reconciliation. A route that says nothing about scope is
 * admin-only by construction, so widening this later is a deliberate edit rather than an oversight.
 *
 * `noStore` because an agenda board is the thing a human is watching to know whether a session is
 * waiting on them; a cached one shows a question that has already been answered.
 */
export function agendaRoutes(
  agenda: AgendaService,
  notifications: DirectNotificationSubsystem,
  replies: AgendaRepliesSubsystem,
  /** The held configuration edits an item may confirm; absent, `--confirms` is refused. */
  config?: AgendaConfigPort,
  /** The card gates an item may ask about; absent, a gate item is answered like any other choice. */
  gates?: AgendaGatePort,
): readonly ApiRoute[] {
  const handleList: ApiRoute['handle'] = async context => await list(agenda, replies, context);
  const handleApply: ApiRoute['handle'] = async context =>
    await apply(agenda, notifications, replies, config, gates, context);
  const handleReplies: ApiRoute['handle'] = async context => await sendReplies(agenda, replies, context);
  const routes: readonly ApiRoute[] = [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/agenda/:id',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => {
        const result = await agenda.list(pathSessionId(context));
        if (!result.ok) return refusal(result.error);
        const snapshot = result.value;
        const id = pathItemId(context);
        const item = snapshot.items.find(item => item.id === id) ?? snapshot.resolved.find(item => item.id === id);
        if (item === undefined) throw new ApiError(404, 'agenda item not found', 'not-found');
        return jsonResponse(item);
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/agenda',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: handleList,
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/agenda',
      minimum: 'operator',
      caller: 'any',
      // No capability: the board is gated by who acts (docs/grants.md). But an answer that confirms a held
      // configuration change asks that file's grant, so the boundary hands the handler the caller's standing.
      consultsGrants: true,
      noStore: true,
      handle: handleApply,
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/agenda/:id/conversation',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => {
        const query = AgendaConversationQuerySchema.safeParse({
          index: queryValue(context.request, 'index'),
          offset: queryValue(context.request, 'offset'),
          version: queryValue(context.request, 'version'),
        });
        if (!query.success)
          throw new ApiError(
            400,
            'conversation cursor must use nonnegative integers and a positive version',
            'invalid',
          );
        const result = await agenda.conversationOf(
          pathSessionId(context),
          pathItemId(context),
          query.data.index,
          query.data.offset,
          query.data.version,
        );
        return result.ok ? jsonResponse(AgendaConversationPageSchema.parse(result.value)) : refusal(result.error);
      },
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/agenda/:id/versions',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await listVersions(agenda, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/agenda/:id/versions/:version',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      handle: async context => await getVersion(agenda, context),
    },
    {
      method: 'PUT',
      path: '/v1/sessions/:sessionId/agenda/:id/seen',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => await markSeen(agenda, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/agenda/replies',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: handleReplies,
    },
  ];
  // Every session agenda route passes here, including future item reads. Refuse the reserved ledger before
  // parsing a body or cursor, consulting gates, delivering replies, or touching any service.
  const guarded = new Map<ApiRoute['handle'], ApiRoute['handle']>();
  return routes.map(route => {
    let handle = guarded.get(route.handle);
    if (handle === undefined) {
      handle = async context => {
        pathSessionId(context);
        return await route.handle(context);
      };
      guarded.set(route.handle, handle);
    }
    return { ...route, handle };
  });
}
