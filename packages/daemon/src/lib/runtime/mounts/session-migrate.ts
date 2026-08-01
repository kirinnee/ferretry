import { FY_REQUEST_ID_HEADER, MigrateSessionRequestSchema, type SessionView } from '@ferretry/protocol';
import {
  MIGRATION_REPLAY_MAX_ENTRIES,
  MigrationReplayCapacityError,
  MigrationReplayGuard,
  MigrationReplayMismatchError,
} from '../../migrate/replay-guard.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, headerValue, type ApiRequest, type ApiResponse } from '../../api/http.ts';
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
  // 409: the id is usable, but it already names a different migration, and the caller has to decide
  // which one it meant. Not 400 — the request itself is well formed.
  if (error instanceof MigrationReplayMismatchError) throw new ApiError(409, error.message, 'request_id_reused');
  // 503: the request is valid and the caller did nothing wrong — this daemon has simply recorded as
  // many migrations as it will hold, and it refuses to start another rather than discard a receipt and
  // let some later retry relaunch a session twice. NOTHING WAS DESTROYED to produce this answer.
  //
  // 503 rather than 429, because this is not a rate: waiting does not clear it. The ledger frees a
  // slot only when a migration is refused before it touches the pane, and otherwise not until the
  // process restarts — which the message says outright, since it is the operator's actual remedy.
  if (error instanceof MigrationReplayCapacityError) throw new ApiError(503, error.message, 'migration_ledger_full');
  throw error;
}

/**
 * Whether a rejection arrived AFTER the migration destroyed the pane.
 *
 * Only `failed` is: its own doc comment says "the relaunch under the new account was attempted and
 * failed. The session records why" — the kill and the restamp are already behind it, so an automatic
 * retry would relaunch a session that has no pane left. Every other failure in the taxonomy is
 * decided before anything is touched: `invalid` and `not_found` never reach the session, `unusable`
 * is refused precisely because nothing can be restamped safely, `unknown_agent` and `unavailable`
 * reject the target, and `refused`/`context_downgrade` are the two gates that exist to stop the
 * destruction happening. Those must stay retryable so the sheet's "Retry safety check" re-evaluates.
 *
 * An error outside the taxonomy — a bug, an I/O fault mid-relaunch — is retained. It cannot be
 * placed relative to the point of no return, and the safe assumption about an unplaceable failure in
 * a destructive operation is that the destruction happened.
 */
function committedAfterDestruction(error: unknown): boolean {
  return error instanceof SessionMigrateError ? error.failure === 'failed' : true;
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
 * The logical request id this migration is identified by.
 *
 * MANDATORY, for the same reason the start's is: the protocol client retries this POST up to three
 * times on transport failure, and a migration kills and relaunches a pane. A request that cannot be
 * recognised on its second arrival cannot be protected from performing its destruction twice, so the
 * daemon refuses to begin one rather than accept a caller's word that it will never retry.
 */
function requestId(request: ApiRequest): string {
  const value = headerValue(request, FY_REQUEST_ID_HEADER)?.trim() ?? '';
  if (value === '')
    throw new ApiError(
      400,
      `a migration must carry ${FY_REQUEST_ID_HEADER}: without it a retried request relaunches the session a second time`,
      'missing_request_id',
    );
  return value;
}

/** Migrates a session, or answers a stated refusal — at most once per logical request id. */
async function migrate(
  subsystem: SessionMigrateSubsystem,
  guard: MigrationReplayGuard,
  context: RouteContext,
): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const request = await parseBody(context.request, MigrateSessionRequestSchema);
  const id = requestId(context.request);
  const target = {
    agent: request.agent,
    ...(request.model === undefined ? {} : { model: request.model }),
    allowContextDowngrade: request.allowContextDowngrade,
  };
  // The fingerprint is the PARSED target, not the raw bytes: the start's digest has to hash the bytes
  // because a third party presents it later as proof, whereas this only ever compares two requests
  // the daemon parsed itself — and two spellings of one target are the same migration.
  const fingerprint = JSON.stringify([target.agent, target.model ?? null, target.allowContextDowngrade]);
  const view = await guard
    .run({ sessionId, requestId: id }, fingerprint, async () => await subsystem.migrate(sessionId, target))
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
 *
 * `maxReplayEntries` exists so a test can reach the ledger's admission limit in three requests instead
 * of four thousand. Production never passes it.
 */
export function sessionMigrateRoutes(
  subsystem: SessionMigrateSubsystem,
  maxReplayEntries: number = MIGRATION_REPLAY_MAX_ENTRIES,
): readonly ApiRoute[] {
  // One guard per mount, so it lives as long as the daemon does. A guard created per request would
  // recognise nothing, which is the bug this route had.
  const guard = new MigrationReplayGuard(committedAfterDestruction, maxReplayEntries);
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/migrate',
      scope: 'admin',
      noStore: true,
      handle: async context => await migrate(subsystem, guard, context),
    },
  ];
}
