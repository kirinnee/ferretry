import { type AttentionErrorCode, AttentionActionRequestSchema } from '@ferretry/protocol';
import { isHumanAdminActor, parseActor, type ApiActor } from '../../api/actor.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import {
  isAttentionSessionId,
  type AttentionActor,
  type AttentionFailure,
  type AttentionService,
} from '../../attention/index.ts';

/**
 * The attention board's HTTP surface: what a session is blocked on, and the human's answer to it.
 *
 * This is the route table the CLI's `ProtocolAttentionGateway` already speaks — `GET` and `POST` on
 * `/v1/sessions/:sessionId/attention` — so mounting it is what turns the shipped `fy attention`,
 * `fy answer` and `fy resolve` commands from 404s into a working capability.
 *
 * `POST /v1/sessions/:sessionId/notify` is deliberately NOT here. It pushes to the human's devices,
 * and the daemon has no push subsystem yet; answering it with anything would claim a delivery that
 * never happened, and `unknown_route` is the honest answer until the transport exists.
 */

/**
 * How each domain refusal is reported.
 *
 * `corrupt` is the one that is not the caller's fault: an unreadable ledger is the daemon's data
 * problem, and reporting it as a 4xx would send an operator auditing their own request. `full` and
 * `read-only` are conflicts rather than bad requests — the request was well-formed and the board's
 * current state is what refused it.
 */
const ATTENTION_ERROR_STATUS: Readonly<Record<AttentionErrorCode, number>> = {
  invalid: 400,
  'too-long': 400,
  'not-found': 404,
  forbidden: 403,
  'rate-limited': 429,
  'read-only': 409,
  full: 409,
  corrupt: 500,
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
export function attentionActor(actor: ApiActor | undefined): AttentionActor {
  const { kind, id } = parseActor(actor ?? '');
  if (kind === 'peer' && id !== undefined && isAttentionSessionId(id)) {
    return { kind: 'agent', sessionId: id, name: null };
  }
  // Host admin actors and a registry-resolved paired device are the two human
  // forms this route can receive. Everything else is unavailable provenance,
  // never a benign default to human authority.
  if (isHumanAdminActor(actor) || (kind === 'device' && id !== undefined && id.trim() !== '')) {
    return { kind: 'human' };
  }
  throw new ApiError(403, 'attention mutations require established human or session provenance', 'forbidden');
}

/** Turns a domain refusal into its HTTP answer, keeping the domain's own code for the client. */
function refusal(error: AttentionFailure): never {
  throw new ApiError(ATTENTION_ERROR_STATUS[error.code], error.message, error.code);
}

/** The path's session id, decoded. `decodeParameter` refuses a traversal or a separator, so a
 *  crafted id can never address a ledger outside the session tree. */
function pathSessionId(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined) throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

async function list(attention: AttentionService, context: RouteContext): Promise<ApiResponse> {
  const result = await attention.list(pathSessionId(context));
  return result.ok ? jsonResponse(result.value) : refusal(result.error);
}

/**
 * Applies one board action.
 *
 * `resolve` carrying a `response` is an ANSWER — the human chose one of the options the agent
 * offered — and `resolve` without one is the human closing the item out. The source conflated the
 * two into a single write that recorded no answer at all, so an agent waiting on a choice was
 * unblocked with nothing to read.
 */
async function apply(attention: AttentionService, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const request = await parseBody(context.request, AttentionActionRequestSchema);
  const actor = attentionActor(context.actor);
  const mutation = await (request.action === 'add'
    ? attention.raise(sessionId, request, actor)
    : request.action === 'dismiss'
      ? attention.dismiss(sessionId, request.id, actor, request.note)
      : request.response === undefined
        ? attention.resolve(sessionId, request.id, actor, request.note)
        : attention.answer(sessionId, request.id, request.response, actor, request.note));
  return mutation.ok ? jsonResponse(mutation.snapshot) : refusal(mutation.error);
}

/**
 * `admin` scope on both, which is the conservative reading of a surface a warden can currently only
 * reach through the daemon's own trusted reconciliation. A route that says nothing about scope is
 * admin-only by construction, so widening this later is a deliberate edit rather than an oversight.
 *
 * `noStore` because an attention board is the thing a human is watching to know whether a session is
 * waiting on them; a cached one shows a question that has already been answered.
 */
export function attentionRoutes(attention: AttentionService): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/attention',
      scope: 'admin',
      minimum: 'operator',
      noStore: true,
      handle: async context => await list(attention, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/attention',
      scope: 'admin',
      minimum: 'operator',
      noStore: true,
      handle: async context => await apply(attention, context),
    },
  ];
}
