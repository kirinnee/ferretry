import { SignalSessionRequestSchema, type SessionView, type SignalSessionRequest } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/**
 * What a session says about itself: `POST /v1/sessions/:sessionId/signal`.
 *
 * THE DAEMON HAD NO WAY TO BE TOLD A SESSION HAD FINISHED. `IFyApiClient.signal` has always posted
 * here and the daemon answered `unknown_route`, so `done`, `help`, `waiting` and `working` were four
 * verbs the product declared on the wire and could not serve. The consequences were not cosmetic:
 *
 *   * NO SESSION COULD EVER COMPLETE. `completed` is written by exactly one path in kteam — this one
 *     — and `FileResumeTurnStore.clearMarkers` already deletes a `done` marker before every revive
 *     that nothing in the daemon ever wrote. An automode teammate finished its work and the fleet
 *     could not tell it apart from one that had hung.
 *   * AN AUTOMODE TEAMMATE THAT ASKED A HUMAN A QUESTION JUST STOPPED. The help protocol exists so
 *     that an agent with nobody watching fails loudly instead of sitting at a prompt forever.
 *   * A DECLARED WAIT COULD NOT BE DECLARED, while the half that READS one was already ported:
 *     `lib/warden/detect.ts` reasons about `state.waiting`, its peer and its backstop, and no code
 *     path could put one there. The detector was watching a field that was always absent.
 *
 * WHY `admin` SCOPE. The natural reading is that a session should sign its own signals, and the
 * daemon does mint a per-session credential — but that credential authorizes the TASK-BOARD domain
 * today, and nothing on this side of the daemon can yet turn it into "the caller IS session X". A
 * session-scoped token that this route trusted to name its own subject would let any holder complete
 * or park any other session. Until a unit lands that identity, `admin` is the honest answer: the
 * fleet wrappers already hold the admin token, which is how `kteam signal done` works today.
 *
 * WHY THE ANSWER IS A SESSION VIEW. The wire shape the client parses is `SessionView`, the same one
 * the stop and the revive answer with, and it carries everything a signal changes: the status, the
 * health, and the declared wait itself.
 */

/** Why a signal could not be acted on. */
export type SessionSignalFailure =
  /** The id is not one the state-home layout would accept, or the request describes an impossible wait. */
  | 'invalid'
  /** No such session. */
  | 'not_found'
  /** The session's own condition refuses the signal — it is already terminal, or it named itself as peer. */
  | 'refused'
  /** The wait named a session that resolves to nobody, so the park could never end on a reply. */
  | 'unknown_peer'
  /** The signal was acted on and the work it does — retiring a pane, writing evidence — failed. */
  | 'failed';

/** A refusal raised by the composition root's signal handling, in a taxonomy `src/lib` may name. */
export class SessionSignalError extends Error {
  constructor(
    readonly failure: SessionSignalFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionSignalError';
  }
}

/** One session speaking about itself. The request is the parsed wire shape, unchanged. */
export interface SessionSignalSubsystem {
  signal(sessionId: string, request: SignalSessionRequest): Promise<SessionView>;
}

/** The HTTP status and code each refusal answers with. */
const REFUSALS: Readonly<Record<SessionSignalFailure, { readonly status: number; readonly code: string }>> = {
  invalid: { status: 400, code: 'invalid_request' },
  not_found: { status: 404, code: 'not-found' },
  refused: { status: 409, code: 'signal_refused' },
  // `404`, not `400`: the request is well formed and the thing it names is simply not here, which is
  // the same answer a caller gets for addressing any other absent session.
  unknown_peer: { status: 404, code: 'unknown_peer' },
  failed: { status: 500, code: 'session_signal_failed' },
};

/** Restates a signal refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof SessionSignalError) {
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
 * Records what the session said about itself, or answers a stated refusal.
 *
 * The body is REQUIRED rather than optional, unlike the revive's: `kind` is the whole request, and an
 * empty body would otherwise have to be given a default meaning. There is no safe default among
 * "finish", "ask a human", "park" and "carry on".
 */
async function signal(subsystem: SessionSignalSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const request = await parseBody(context.request, SignalSessionRequestSchema);
  const view = await subsystem.signal(sessionId, request).catch(refuse);
  return jsonResponse(view);
}

/**
 * `admin` scope — see the header for why a session cannot yet sign for itself.
 *
 * `noStore` because the answer is a live session view whose status is exactly what this call changed;
 * a cached one shows the session as it was before it finished or parked.
 */
export function sessionSignalRoutes(subsystem: SessionSignalSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/signal',
      scope: 'admin',
      noStore: true,
      handle: async context => await signal(subsystem, context),
    },
  ];
}
