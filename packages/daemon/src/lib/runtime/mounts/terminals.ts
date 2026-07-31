import {
  CreateTerminalRequestSchema,
  RenameTerminalRequestSchema,
  TerminalIdSchema,
  type CloseTerminalResponse,
  type CreateTerminalRequest,
  type TerminalErrorCode,
  type TerminalListView,
  type TerminalView,
} from '@ferretry/protocol';
import { parseBody, parseOptionalBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { TerminalPolicyError } from '../../terminal/policy.ts';

/**
 * Independent shell terminals attached to a session's working directory.
 *
 * The lifecycle service, the tmux runtime behind it and the sizing, titling and idle policies were
 * built and fully tested by PR #21, and nothing constructed them: the daemon could not open a
 * terminal at all. This mounts the LIFECYCLE — open one, list them, retitle one, close one — over
 * the routes the protocol's terminal contracts describe.
 *
 * WHAT IS DELIBERATELY NOT SERVED HERE. Terminal INPUT and OUTPUT are websocket business: the
 * protocol says so in as many words, giving raw bytes their own frame type and reserving JSON for
 * the resize control frame. The daemon's API surface is request/response only — `ApiResponse` is a
 * string body, and there is no socket seam a route could hand a peer to — so `TerminalStreamBridge`
 * stays unmounted rather than being reached through an HTTP endpoint the protocol never described.
 * Inventing `POST …/input` here would put a second, slower, lossier input path into the product and
 * call the streaming subsystem wired.
 *
 * SIZE AND TITLE ARE THE SERVICE'S TO DECIDE. The schemas below refuse a body outside the protocol's
 * bounds, and the service then normalises what survives — clamping a size, defaulting a title — so a
 * client that omits both still gets a usable terminal rather than an argument.
 */

/**
 * The terminal lifecycle as the routes need it.
 *
 * Declared here rather than imported because `ManagedTerminalService` is an ADAPTER and `src/lib`
 * may not import `src/adapters`. The service satisfies this structurally, so the composition root
 * hands one over behind a thin translation of its error taxonomy — see `TerminalMountError`.
 */
export interface TerminalSubsystem {
  list(sessionId: string): Promise<TerminalListView>;
  create(sessionId: string, input: CreateTerminalRequest): Promise<TerminalView>;
  get(sessionId: string, terminalId: string): Promise<TerminalView>;
  rename(sessionId: string, terminalId: string, title: string): Promise<TerminalView>;
  close(sessionId: string, terminalId: string): Promise<void>;
}

/**
 * A terminal refusal, in the protocol's own vocabulary.
 *
 * The service and the tmux runtime raise their own error classes, and both live in `src/adapters`
 * where a route may not look. The composition root translates them into this once, so the mount
 * answers `capacity` with 409 instead of turning a full terminal list into a 500 about tmux.
 */
export class TerminalMountError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TerminalMountError';
  }
}

/**
 * How each refusal is reported.
 *
 * `capacity` is a CONFLICT rather than a bad request — the request was well-formed and the fleet's
 * current terminal count is what refused it — so a client can tell "close one and retry" apart from
 * "you asked wrongly". `upstream_failed` is 502: tmux answered, and it answered with a failure, which
 * is not the caller's fault and not a bug in the daemon either.
 */
const TERMINAL_ERROR_STATUS: Readonly<Record<TerminalErrorCode, number>> = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  capacity: 409,
  unavailable: 503,
  upstream_failed: 502,
};

/** Re-raises a terminal refusal as its HTTP answer, and anything else as itself so a genuine bug
 *  still becomes a 500 rather than being blamed on the caller. */
function reraise(error: unknown): never {
  if (error instanceof TerminalMountError)
    throw new ApiError(TERMINAL_ERROR_STATUS[error.code], error.message, error.code);
  // A policy refusal is always about the values in the request — a title of control characters, a
  // size that is not a number — so it is the caller's mistake wherever it is raised.
  if (error instanceof TerminalPolicyError) throw new ApiError(400, error.message, 'bad_request');
  throw error;
}

/** A decoded path parameter. `decodeParameter` refuses a traversal or a separator, so a crafted
 *  value can never name a terminal outside the session that owns it. */
function pathParameter(context: RouteContext, name: string, code: string): string {
  const decoded = decodeParameter(context.params.get(name) ?? '');
  if (decoded === undefined || decoded === '') throw new ApiError(400, `the ${name} in the path is not usable`, code);
  return decoded;
}

const pathSessionId = (context: RouteContext): string => pathParameter(context, 'sessionId', 'invalid_session_id');

/**
 * The terminal named in the path.
 *
 * The id is PARSED against the protocol's own shape rather than passed through: a terminal id is a
 * twelve-character hex string, and anything else cannot name a terminal this daemon ever minted, so
 * it is refused as a bad request instead of being looked up and reported as a 404 the caller would
 * read as "it was closed".
 */
function pathTerminalId(context: RouteContext): string {
  const raw = pathParameter(context, 'terminalId', 'invalid_terminal_id');
  const parsed = TerminalIdSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, 'the terminalId in the path is not a terminal id', 'bad_request');
  return parsed.data;
}

/** Every terminal the session owns, with the limits the caller is being held to. */
async function list(subsystem: TerminalSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  return jsonResponse(await subsystem.list(sessionId).catch(reraise));
}

/** Opens one terminal in the session's own working directory. */
async function create(subsystem: TerminalSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  // Every field is optional, so an empty body means "open me a terminal, you choose" rather than a
  // malformed request — which is exactly what a PWA button sends.
  const request = await parseOptionalBody(context.request, CreateTerminalRequestSchema);
  return jsonResponse(await subsystem.create(sessionId, request).catch(reraise), 201);
}

/** One terminal, as it stands now. */
async function detail(subsystem: TerminalSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const terminalId = pathTerminalId(context);
  return jsonResponse(await subsystem.get(sessionId, terminalId).catch(reraise));
}

/** Retitles one terminal. */
async function rename(subsystem: TerminalSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const terminalId = pathTerminalId(context);
  const request = await parseBody(context.request, RenameTerminalRequestSchema);
  return jsonResponse(await subsystem.rename(sessionId, terminalId, request.title).catch(reraise));
}

/** Closes one terminal, killing the shell behind it. */
async function close(subsystem: TerminalSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const terminalId = pathTerminalId(context);
  await subsystem.close(sessionId, terminalId).catch(reraise);
  const response: CloseTerminalResponse = { closed: true, id: terminalId };
  return jsonResponse(response);
}

/**
 * `admin` scope throughout: a terminal is an unsupervised shell in the session's working directory,
 * which is the most powerful thing this API can hand out. A warden-scoped token judges sessions; it
 * has no business opening one.
 *
 * `noStore` because the list is what a human is looking at to decide whether to open another, and a
 * cached one shows terminals that have already been closed.
 */
export function terminalRoutes(subsystem: TerminalSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/terminals',
      scope: 'admin',
      noStore: true,
      handle: async context => await list(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/terminals',
      scope: 'admin',
      noStore: true,
      handle: async context => await create(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/terminals/:terminalId',
      scope: 'admin',
      noStore: true,
      handle: async context => await detail(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/terminals/:terminalId',
      scope: 'admin',
      noStore: true,
      handle: async context => await rename(subsystem, context),
    },
    {
      method: 'DELETE',
      path: '/v1/sessions/:sessionId/terminals/:terminalId',
      scope: 'admin',
      noStore: true,
      handle: async context => await close(subsystem, context),
    },
  ];
}
