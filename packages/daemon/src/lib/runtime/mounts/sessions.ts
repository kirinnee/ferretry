import type { SessionList, SessionView } from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

/**
 * The session READ surface: every session the daemon holds, and one session in full.
 *
 * These are the two routes the protocol client's `list` and `get` already speak —
 * `GET /v1/sessions` and `GET /v1/sessions/:sessionId` — and the daemon answered `unknown_route` to
 * both. Every other per-session route the daemon mounts (tasks, pins, attention, terminals) is
 * addressed by an id a caller cannot discover without this, so the read is the one that makes the
 * rest usable by something other than a caller who already knew the id.
 *
 * A `SessionView` is the two authoritative documents plus the directory that holds them, and the
 * daemon already owns all three: the session index lists what exists, the state home holds the
 * documents, and the layout derives the directory. Nothing here is derived from anything else.
 *
 * WHAT IS DELIBERATELY NOT SERVED HERE. Session START, SEND and STOP stay unmounted. Reading is
 * separable from writing — a list is a projection of documents that already exist, while a start
 * spawns a harness, claims a callsign and registers a managed worktree — and this mount does not
 * pretend otherwise. Until that unit lands the list answers with exactly what the index holds, which
 * on a daemon that has never created a session is an empty array, and an empty array is the truth
 * rather than a placeholder.
 *
 * WHY AN UNUSABLE DOCUMENT IS SKIPPED FROM THE LIST BUT REFUSED BY THE READ. The wire shape of the
 * list is a bare array with nowhere to report a count of documents that would not parse, and one
 * corrupt session must not take `fy ps` down for the whole fleet. So the list omits it — a missing
 * row is visible under-reporting — while `GET /v1/sessions/:sessionId` on that same session answers a
 * stated failure. A human who notices the gap can therefore ask about that session directly and be
 * told the truth, instead of being told it does not exist.
 */

/** Why one session could not be read. */
export type SessionReadFailure =
  /** The id is not one the state-home layout would accept, so it must never become a path. */
  | 'invalid'
  /** The documents exist and the protocol schema refused them. */
  | 'unusable';

/** A refusal raised by the composition root's reader, in a taxonomy `src/lib` may name. */
export class SessionReadError extends Error {
  constructor(
    readonly failure: SessionReadFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionReadError';
  }
}

/**
 * The authoritative session set, as these routes need it.
 *
 * `list` returns only the sessions whose documents parsed; `get` distinguishes "no such session"
 * (`undefined`) from "the documents would not parse" (a `SessionReadError`), because collapsing the
 * second into the first would report a session the index holds as one that never existed.
 */
export interface SessionDirectorySubsystem {
  list(): Promise<readonly SessionView[]>;
  get(sessionId: string): Promise<SessionView | undefined>;
}

/** The raw path parameter, decoded. A parameter that regains a separator never reaches the reader. */
function pathSessionId(context: RouteContext): string {
  const raw = context.params.get('sessionId') ?? '';
  const decoded = decodeParameter(raw);
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

/** Restates a reader refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof SessionReadError) {
    throw error.failure === 'invalid'
      ? new ApiError(400, error.message, 'invalid_session_id')
      : new ApiError(500, error.message, 'unusable_session_document');
  }
  throw error;
}

/** Every session the index holds, in the index's own order. */
async function list(subsystem: SessionDirectorySubsystem): Promise<ApiResponse> {
  const sessions: SessionList = [...(await subsystem.list().catch(refuse))];
  return jsonResponse(sessions);
}

/** One session in full, or a stated refusal. */
async function read(subsystem: SessionDirectorySubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const view = await subsystem.get(sessionId).catch(refuse);
  if (view === undefined) throw new ApiError(404, `no session ${sessionId}`, 'not-found');
  return jsonResponse(view);
}

/**
 * `admin` scope: a session view carries the working directory, the harness, the selected model and
 * the launch window — the operator's whole configuration for that agent — so it is not warden-
 * readable until a unit decides deliberately that it should be.
 *
 * `noStore` because a session view is live state: status, turn count and last activity are exactly
 * what a human is watching, and a cached one shows a session that has already moved on.
 *
 * The fleet read is registered FIRST so its fixed literal path cannot be shadowed by the pattern
 * beneath it, matching the ordering rule the base feeds and the task board follow.
 */
export function sessionRoutes(subsystem: SessionDirectorySubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions',
      minimum: 'operator',
      noStore: true,
      handle: async () => await list(subsystem),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId',
      minimum: 'operator',
      noStore: true,
      handle: async context => await read(subsystem, context),
    },
  ];
}
