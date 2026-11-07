import type { ArchivedSessions, SessionView } from '../../protocol/session.ts';
import { ApiError, type ApiRequest, type ApiResponse, jsonResponse, type RouteHandler } from '@ferretry/kernel/contract';
import type { ArchivePassResult } from '../../session/archive/index.ts';

/**
 * The older finished autonomous sessions the daemon took out of the live list (docs/session-archive.md).
 *
 * `GET /v1/archived-sessions?limit=N` answers how many there are and the newest `limit` of them in full, so the app's
 * "K older finished sessions archived" line costs one number (`limit=0`) and "show them" costs one read of the few the
 * person asked to see. It is a SEPARATE route, not a flag on `GET /v1/sessions`: the live list is the hot one every
 * open app re-reads on a beat, and an archived session must never be able to slip into it.
 *
 * One archived session is read like any other — `GET /v1/sessions/:sessionId` — lazily, from disk.
 */
export interface SessionArchiveSubsystem {
  /** How many sessions are archived. */
  count(): number;
  /** The newest `limit` archived sessions as views, newest first; one whose documents do not parse is left out. */
  list(limit: number): Promise<readonly SessionView[]>;
  /** One archive pass. Absent where archiving is off; `undefined` when a pass is already running. */
  readonly run?: () => Promise<ArchivePassResult | undefined>;
}

export const ARCHIVED_SESSIONS_LIMIT_DEFAULT = 100;
export const ARCHIVED_SESSIONS_LIMIT_MAX = 500;

function requestedLimit(request: ApiRequest): number {
  for (const [name] of request.query) {
    if (name !== 'limit') throw new ApiError(400, `unknown parameter ${name}`, 'unknown_parameter');
  }
  const raw = request.query.get('limit')?.[0];
  if (raw === undefined) return ARCHIVED_SESSIONS_LIMIT_DEFAULT;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > ARCHIVED_SESSIONS_LIMIT_MAX)
    throw new ApiError(
      400,
      `limit must be a whole number from 0 to ${String(ARCHIVED_SESSIONS_LIMIT_MAX)}`,
      'invalid_limit',
    );
  return limit;
}

/** `GET /v1/archived-sessions` (R-0047, path unchanged per the parity table), keyed for the manifest. */
export function sessionArchiveRoutes(subsystem: SessionArchiveSubsystem): {
  readonly 'GET /v1/archived-sessions': RouteHandler;
} {
  return {
    'GET /v1/archived-sessions': async (context): Promise<ApiResponse> => {
      const limit = requestedLimit(context.request);
      const sessions = limit === 0 ? [] : [...(await subsystem.list(limit))];
      const body: ArchivedSessions = { count: subsystem.count(), sessions };
      return jsonResponse(body);
    },
  };
}
