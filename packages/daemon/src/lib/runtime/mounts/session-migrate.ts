import { MigrateSessionRequestSchema, type SessionView } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/**
 * Moving a live session onto another account: `POST /v1/sessions/:sessionId/migrate`.
 *
 * `MigrationPreflight` — the gate that inventories a pane's in-flight work and REFUSES to destroy
 * work it cannot show will survive the relaunch — was built, fully tested, constructed in the world
 * as `migratePreflight`, and called by nothing. The protocol client's `migrate()` has always spoken
 * this route, and the daemon answered `unknown_route`, so the one safety gate in the product guarded
 * an operation the product could not perform.
 *
 * WHAT A MIGRATION IS HERE. The session keeps its id, its directory, its journal and its whole
 * conversation on disk; what changes is the account and model its NEXT incarnation runs under. The
 * old pane is snapshotted and killed, the configuration document is restamped, and the replacement
 * agent is handed a turn document pointing at the forensic report of what the kill interrupted.
 *
 * THE GATE CANNOT BE FORCED THROUGH THIS ROUTE, and that is deliberate rather than an oversight.
 * `MigrateSessionRequest` carries `agent`, `model` and `allowContextDowngrade` and no force flag, so
 * a `destructive_to_interrupt` or `unknown` verdict is a 409 with the inventory in it. The renderer
 * still has its `forced` branch because kteam's CLI had `--force-inflight`; adding one here is a WIRE
 * change, and a route that quietly forced past a refusal would make the whole preflight decorative.
 *
 * `allowContextDowngrade` is NOT that force flag: it answers a different question — whether the
 * caller accepts a target whose context window is smaller than the one this session is running in,
 * which silently truncates the conversation the migration exists to preserve.
 */

/** Why a migration could not be performed. */
export type SessionMigrateFailure =
  /** The id is not one the state-home layout would accept, so it must never become a path. */
  | 'invalid'
  /** No such session. */
  | 'not_found'
  /** The session's own documents do not satisfy the protocol, so nothing can be restamped safely. */
  | 'unusable'
  /** No account in the fleet manifest is published under the requested agent. */
  | 'unknown_agent'
  /** The account cannot serve a session right now, or this host cannot run its wrapper. */
  | 'unavailable'
  /** The preflight found in-flight work it will not destroy, or could not rule some out. */
  | 'refused'
  /** The target's context window is smaller and the caller did not accept the truncation. */
  | 'context_downgrade'
  /** The relaunch under the new account was attempted and failed. The session records why. */
  | 'failed';

/** A refusal raised by the composition root's migrator, in a taxonomy `src/lib` may name. */
export class SessionMigrateError extends Error {
  constructor(
    readonly failure: SessionMigrateFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionMigrateError';
  }
}

/**
 * Migrating one session onto another account.
 *
 * The request is passed through as the protocol parsed it rather than as three arguments, because
 * every field is a decision the composition root makes against the fleet manifest and this host —
 * which account, which model, and whether a smaller context window is acceptable — and none of them
 * is a decision this mount is entitled to make on the caller's behalf.
 */
export interface SessionMigrateSubsystem {
  migrate(
    sessionId: string,
    request: { readonly agent: string; readonly model?: string; readonly allowContextDowngrade: boolean },
  ): Promise<SessionView>;
}

/** The HTTP status and code each refusal answers with. */
const REFUSALS: Readonly<Record<SessionMigrateFailure, { readonly status: number; readonly code: string }>> = {
  invalid: { status: 400, code: 'invalid_session_id' },
  not_found: { status: 404, code: 'not-found' },
  unusable: { status: 409, code: 'session_unusable' },
  unknown_agent: { status: 404, code: 'unknown_agent' },
  unavailable: { status: 503, code: 'agent_unavailable' },
  // 409 rather than 403: the session's own condition refuses this, and it is answerable — the
  // caller waits for the work to finish, or stops it deliberately, and asks again.
  refused: { status: 409, code: 'migration_refused' },
  context_downgrade: { status: 409, code: 'context_downgrade_refused' },
  failed: { status: 500, code: 'session_migrate_failed' },
};

/** Restates a migration refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof SessionMigrateError) {
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

/** Migrates a session, or answers a stated refusal. */
async function migrate(subsystem: SessionMigrateSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const request = await parseBody(context.request, MigrateSessionRequestSchema);
  const view = await subsystem
    .migrate(sessionId, {
      agent: request.agent,
      ...(request.model === undefined ? {} : { model: request.model }),
      allowContextDowngrade: request.allowContextDowngrade,
    })
    .catch(refuse);
  return jsonResponse(view);
}

/**
 * `admin` scope, for the same reason the start, the stop and the revive are: a migration kills one
 * agent process holding the daemon's own privileges and launches another under a different account.
 *
 * The body is MANDATORY here, unlike the revive's: a migration with no target agent is not a
 * migration with a default, it is a request that names nothing to move to.
 *
 * `noStore` because the answer is a live session view whose agent, model and status are exactly what
 * the call changed; a cached one describes the account the session just left.
 */
export function sessionMigrateRoutes(subsystem: SessionMigrateSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/migrate',
      scope: 'admin',
      noStore: true,
      handle: async context => await migrate(subsystem, context),
    },
  ];
}
