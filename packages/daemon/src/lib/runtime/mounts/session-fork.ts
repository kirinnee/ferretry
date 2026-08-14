import {
  type ForkSessionFailure,
  type ForkSessionOutcome,
  ForkSessionOutcomeSchema,
  type ForkSessionRequest,
  ForkSessionRequestSchema,
  FY_REQUEST_ID_HEADER,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiRequest, type ApiResponse, decodeParameter, headerValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/**
 * Forking a conversation from an exact message: `POST /v1/sessions/:sessionId/fork`.
 *
 * WHAT A FORK IS HERE, AND WHY IT IS NOT A MIGRATION. A migration keeps the session and changes the
 * account beneath it: the pane is killed, the configuration document is restamped, and the session
 * that comes back is the same session. A fork touches its source NOTHING at all. It reads the source
 * through one durable message, writes a brand-new session with a fresh identity, and leaves the
 * source, its descendants, its waiters and its pointers byte-for-byte as they were.
 *
 * THAT DIFFERENCE IS THE WHOLE REASON THIS MOUNT HOLDS NO REPLAY GUARD. The migrate route keeps an
 * in-memory ledger because a lost response there could relaunch a pane a second time, and the memory
 * of "this id already destroyed something" cannot be rebuilt from disk. A fork destroys nothing, and
 * its idempotency is DURABLE: the fork service claims a receipt keyed on `(source, request id)`
 * before a target may be created, so a retry after a daemon restart replays the same target and the
 * same plan. An in-memory guard beside that would be a SECOND owner of the same fact — one that
 * forgets on restart and would let exactly the retry the durable receipt exists to catch through.
 *
 * SO THE REQUEST ID IS STILL MANDATORY, for the reason the migrate's is: the protocol client retries
 * this POST up to three times on transport failure, and a fork with no logical identity cannot be
 * recognised on its second arrival. The daemon refuses to begin one rather than accept a caller's
 * word that it will never retry. It is a header rather than a body field because that is what the
 * transport actually replays.
 *
 * CROSSING HARNESS FAMILIES IS ALLOWED. There is no `harness_mismatch` in this taxonomy, deliberately:
 * a cross-harness fork is honest normalized-context transfer and is merely lossy, so the answer is a
 * committed outcome whose `plan.notCarried` names what could not cross. Refusing it would be the one
 * shape of dishonesty this feature exists to avoid.
 */

/**
 * A refusal raised by the composition root's fork subsystem, in the taxonomy the WIRE owns.
 *
 * The failure IS the protocol's `ForkSessionFailure`, not a daemon-local vocabulary this mount then
 * translates. A translation table would be a second owner of the same closed set, and the arm that
 * drifted would answer a caller with a code no client branches on. The composition root is
 * responsible for restating its own errors — a durable request-id conflict included — as one of
 * these before it reaches the route.
 */
export class SessionForkRefusal extends Error {
  constructor(
    readonly failure: ForkSessionFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionForkRefusal';
  }
}

/**
 * Forking one session into a fresh one.
 *
 * The three arguments are passed through EXACTLY as the route received them: the source id from the
 * path, the request as the protocol parsed it, and the logical request id from the header. This mount
 * makes no decision on the caller's behalf — which agent, which model, which effort and which message
 * are all decisions the composition root resolves against the fleet manifest, the runtime catalogue
 * and the source transcript, and none of them is a default a route is entitled to invent.
 *
 * There is deliberately NO board, stop or child-grant capability in this interface. A fork never
 * inherits shared-board access and never touches its source, so a port that could do either would be
 * a way to reach those effects that no reading of this route would predict.
 */
export interface SessionForkSubsystem {
  fork(sessionId: string, request: ForkSessionRequest, requestId: string): Promise<ForkSessionOutcome>;
}

/**
 * The HTTP status each refusal answers with. The CODE is the failure itself, so this table holds only
 * the half the wire does not already own.
 */
const REFUSAL_STATUS: Readonly<Record<ForkSessionFailure, number>> = {
  invalid_session_id: 400,
  source_not_found: 404,
  // The coordinate still parses, but its opaque raw-prefix evidence no longer verifies. The caller
  // must list the transcript again and choose from the current rows; no fork effect has begun.
  selection_stale: 409,
  // 409: the source's condition refuses this, and it is answerable — a transcript that is still being
  // written may be complete by the time the caller asks again.
  incomplete_transcript: 409,
  // 404: the request addresses a message, and that message is not in the transcript. The caller's
  // remedy is to pick another one, which is a different fork rather than a different spelling.
  target_not_found: 404,
  // 409 rather than 404: the point exists and is readable, and it is simply not a message a
  // conversation can be cut at. Naming it "not found" would send a caller looking for a typo.
  target_not_message: 409,
  conversation_unavailable: 409,
  lineage_untraceable: 409,
  // 500s: the daemon built a document its own schema rejects, or a plan whose conversation does not
  // reach the cut it claims. The caller did nothing wrong and has no remedy but to report it.
  plan_invalid: 500,
  edge_invalid: 500,
  cut_not_carried: 500,
  // 409s, and the pair that makes a frozen plan safe. The plan was honest when it was prepared and
  // the source has moved under it since, so nothing is written and the caller picks a message again
  // against a transcript that now reads differently. Not a 500: the daemon is behaving correctly by
  // refusing, and a retry of the SAME request would refuse identically.
  cut_unreadable: 409,
  cut_rewritten: 409,
  unknown_agent: 404,
  agent_unavailable: 503,
  // 409: the id is usable, but it already names a different fork, and the caller has to decide which
  // one it meant. Not 400 — the request itself is well formed.
  request_id_reused: 409,
  // 500, and SAFE TO RETRY, unlike the migrate's `failed`. A fork writes nothing to its source and
  // every step after the durable receipt is bound to the fresh target and idempotent, so presenting
  // the same request id again re-drives the same fork rather than creating a second session.
  session_fork_failed: 500,
};

/** Restates a fork refusal in the HTTP vocabulary. Anything else is this daemon being broken. */
function refuse(error: unknown): never {
  if (error instanceof SessionForkRefusal) {
    throw new ApiError(REFUSAL_STATUS[error.failure], error.message, error.failure);
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

/** The logical request id this fork is identified by, and which its durable receipt is keyed on. */
function requestId(request: ApiRequest): string {
  const value = headerValue(request, FY_REQUEST_ID_HEADER)?.trim() ?? '';
  if (value === '')
    throw new ApiError(
      400,
      `a fork must carry ${FY_REQUEST_ID_HEADER}: without it a retried request creates a second forked session`,
      'missing_request_id',
    );
  return value;
}

/** Forks a session, or answers a stated refusal — at most one fresh session per logical request id. */
async function fork(subsystem: SessionForkSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const request = await parseBody(context.request, ForkSessionRequestSchema);
  const id = requestId(context.request);
  const outcome = await subsystem.fork(sessionId, request, id).catch(refuse);
  // Parsed on the way OUT as well: the outcome carries the safe target summary and public plan
  // projection, and a body the client's own schema would reject is a fork that happened and could
  // not be reported.
  return jsonResponse(ForkSessionOutcomeSchema.parse(outcome));
}

/**
 * `operator` scope: a fork launches an agent wrapper holding this daemon's own privileges, under an
 * account the caller chose, in the source session's working directory.
 *
 * The body is MANDATORY. A fork with no `through` is not a fork with a default — there is no obvious
 * message to cut at, and guessing the newest one would silently copy a conversation the caller never
 * looked at.
 *
 * `noStore` because the answer names a session that did not exist a moment ago, together with the
 * decision that built it; a cached one would describe a different fork entirely.
 */
export function sessionForkRoutes(subsystem: SessionForkSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/fork',
      minimum: 'operator',
      noStore: true,
      handle: async context => await fork(subsystem, context),
    },
  ];
}
