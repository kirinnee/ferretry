import {
  AGENDA_PUSH_TITLE_LENGTH,
  type AgendaActionRequest,
  AgendaActionRequestSchema,
  type AgendaErrorCode,
  type AgendaSnapshot,
  clipAtWord,
  type DirectNotificationRequest,
  DirectNotificationRequestSchema,
  DirectNotificationResponseSchema,
  MAX_AGENDA_SUBJECT_LENGTH,
} from '@ferretry/protocol';
import { type ApiActor, isHumanAdminActor, parseActor } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
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
  type RaiseAgendaRequest,
} from '../../agenda/index.ts';
import { type AgendaConfigPort, answerConfirmation, raiseRequestOf } from './agenda-confirms.ts';

/**
 * The attention board's HTTP surface: what a session is blocked on, and the human's answer to it.
 *
 * This is the route table the CLI's `ProtocolAgendaGateway` already speaks — `GET` and `POST` on
 * `/v1/sessions/:sessionId/attention` — so mounting it is what turns the shipped `fy attention`,
 * `fy answer` and `fy resolve` commands from 404s into a working capability.
 *
 * The sibling notify route stays for older CLIs, but ONLY AGENDA ITEMS NOTIFY: it raises an `info`
 * item through the same path as an add, so its push is the item's push and carries the same card. It uses
 * the same server-derived actor and allows an agent only its own session; a human may target any known
 * session. Its delivered count means push endpoints accepted the payload, never that a person observed it.
 */

export interface DirectNotificationSubsystem {
  /** How many devices accepted the push the raise of this item made; zero when it pushed to none. */
  agendaDelivered(sessionId: string, agendaId: string): Promise<number>;
  /** How many devices are enrolled for push on this machine right now. */
  enrolledDevices(): Promise<number>;
}

const NOTIFY_KIND_REFUSAL =
  'progress and finishing never notify the owner — raise an item (fy agenda add) only when they must decide or do something';

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
  return decoded;
}

type HeldReplies = Pick<AgendaRepliesSubsystem, 'pending' | 'delivery'>;

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
  return result.ok ? jsonResponse(await withReplies(replies, sessionId, result.value)) : refusal(result.error);
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
  context: RouteContext,
): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const request = await parseBody(context.request, AgendaActionRequestSchema);
  const actor = agendaActor(context.actor);
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
  const mutation = await (request.action === 'add'
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
              : request.action === 'snooze'
                ? agenda.snooze(sessionId, request.id, request.until, actor)
                : request.action === 'unsnooze'
                  ? agenda.unsnooze(sessionId, request.id, actor)
                  : request.action === 'dismiss'
                    ? agenda.dismiss(sessionId, request.id, actor, request.note)
                    : request.response === undefined
                      ? agenda.resolve(sessionId, request.id, actor, request.note)
                      : agenda.answer(sessionId, request.id, request.response, actor, confirmed?.note ?? request.note));
  if (!mutation.ok) return refusal(mutation.error);
  const written = mutation.change === 'created' || mutation.change === 'refreshed' || mutation.change === 'info-added';
  const warnings = written && mutation.item !== undefined ? lintAgendaWriting(mutation.item) : [];
  const enrolled = mutation.change === 'created' ? await enrolledDevices(notifications) : undefined;
  return jsonResponse({
    ...(await withReplies(replies, sessionId, mutation.snapshot)),
    ...(warnings.length === 0 ? {} : { warnings }),
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
 * The notice an old notify request becomes: its title is the request's own or the start of the text,
 * its subject the text on one line, and the whole text rides in the context when the ask had to be cut.
 */
function infoRequest(request: DirectNotificationRequest): RaiseAgendaRequest {
  const line = request.body.replaceAll(/\s+/gu, ' ').trim();
  const subject = clipAtWord(line, MAX_AGENDA_SUBJECT_LENGTH);
  return {
    source: 'agent-raised',
    sourceRef: null,
    kind: 'info',
    notice: true,
    title: clipAtWord(request.title ?? line, AGENDA_PUSH_TITLE_LENGTH),
    subject,
    why: 'The ferret sent you a message that needs no decision.',
    ...(subject === line ? {} : { context: request.body.trim() }),
    howToResolve: 'Nothing to do: it is a notice.',
  };
}

async function notify(
  agenda: AgendaService,
  notifications: DirectNotificationSubsystem,
  context: RouteContext,
): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const actor = agendaActor(context.actor);
  const request = await parseBody(context.request, DirectNotificationRequestSchema);
  if (request.kind !== undefined) return refusal({ code: 'invalid', message: NOTIFY_KIND_REFUSAL });
  const sender: AgendaActor = actor.kind === 'human' ? { kind: 'daemon', cause: 'system' } : actor;
  const mutation = await agenda.raise(sessionId, infoRequest(request), sender);
  if (!mutation.ok) return refusal(mutation.error);
  const delivered =
    mutation.change === 'created' && mutation.item !== undefined
      ? await notifications.agendaDelivered(sessionId, mutation.item.id).catch(() => 0)
      : 0;
  return jsonResponse(DirectNotificationResponseSchema.parse({ sessionId, delivered }));
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
): readonly ApiRoute[] {
  // One handler per verb, shared by the agenda route and its older `attention` twin, so the two cannot
  // answer differently or declare different grants (`agenda.wire.1`, docs/agenda.md § Compatibility).
  const handleList: ApiRoute['handle'] = async context => await list(agenda, replies, context);
  const handleApply: ApiRoute['handle'] = async context => await apply(agenda, notifications, replies, config, context);
  const handleReplies: ApiRoute['handle'] = async context => await sendReplies(agenda, replies, context);
  return [
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
      method: 'POST',
      path: '/v1/sessions/:sessionId/agenda/replies',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: handleReplies,
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/attention',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      legacy: true,
      handle: handleList,
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/attention',
      minimum: 'operator',
      caller: 'any',
      consultsGrants: true,
      noStore: true,
      legacy: true,
      handle: handleApply,
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/attention/replies',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      legacy: true,
      handle: handleReplies,
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/notify',
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      legacy: true,
      handle: async context => await notify(agenda, notifications, context),
    },
  ];
}
