import { type CloseFinishedTerminalsResponse, type CloseTerminalResponse, type CreateTerminalRequest, CreateTerminalRequestSchema, RenameTerminalRequestSchema, type SurfaceOpener, type TerminalErrorCode, type TerminalHoldersView, TerminalIdSchema, type TerminalListView, type TerminalView } from '../../../../contract/index.ts';
import { parseBody, parseOptionalBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { AuditedRouteRule, AuditedSocketRule } from '../../audit/routes.ts';
import type { ModuleContribution } from '../modules.ts';
import type { SocketDownstream, SocketHandler, SocketRoute } from '../../api/socket.ts';
import type { InputRequestService } from '../../input-requests/service.ts';
import type { TerminalCloseTrigger } from '../../terminal/contracts.ts';
import { decideTerminalOpener } from '../../terminal/ownership.ts';
import { TerminalPolicyError } from '../../terminal/policy.ts';
import { answered, ownerOf } from './input-requests.ts';
import { type SessionConsoleSubsystem, sessionConsoleRoutes } from './session-console-input.ts';
import type { SessionDirectorySubsystem } from './sessions.ts';

/**
 * Independent shell terminals attached to a session's working directory.
 *
 * The lifecycle service, the tmux runtime behind it and the sizing, titling and idle policies were
 * built and fully tested by PR #21, and nothing constructed them: the daemon could not open a
 * terminal at all. This mounts the LIFECYCLE — open one, list them, retitle one, close one — over
 * the routes the protocol's terminal contracts describe.
 *
 * INPUT AND OUTPUT ARE A SOCKET, and now that the API has a socket seam they are served here too —
 * see `terminalSocketRoutes`. They are NOT an HTTP endpoint: the protocol gives raw bytes their own
 * frame type and reserves JSON for the resize control frame, so a `POST …/input` route would have
 * been a second, slower, lossier input path that the protocol never described.
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
  /** Who holds the open terminals across every session, and how many slots remain. */
  holders(): Promise<TerminalHoldersView>;
  /** Closes the terminals of every finished or removed ferret; the live ones are never touched. */
  closeFinished(trigger: TerminalCloseTrigger): Promise<CloseFinishedTerminalsResponse>;
  list(sessionId: string): Promise<TerminalListView>;
  /**
   * Opens a terminal, recording the opener the MOUNT derived — not one the body
   * asked for. The request's `agentSessionId` never reaches the service; it is an
   * input to that derivation and nothing more.
   */
  create(
    sessionId: string,
    input: CreateTerminalRequest & { readonly folder?: string },
    openedBy?: SurfaceOpener,
  ): Promise<TerminalView>;
  get(sessionId: string, terminalId: string): Promise<TerminalView>;
  rename(sessionId: string, terminalId: string, title: string): Promise<TerminalView>;
  close(sessionId: string, terminalId: string): Promise<void>;
  /** Types bytes into the terminal, exactly as a viewer's keystrokes would arrive. */
  write(sessionId: string, terminalId: string, bytes: Uint8Array): Promise<void>;
  /** The terminal's last `lines` lines as plain text. */
  text(sessionId: string, terminalId: string, lines: number): Promise<string>;
  /** The name of the program in the terminal's foreground — its shell when nothing is running. */
  foreground(sessionId: string, terminalId: string): Promise<string>;
  /**
   * Attaches one viewer socket to a terminal the caller has ALREADY been authorized for.
   *
   * It answers with a handler rather than doing the streaming, for the same reason the rest of this
   * interface is declared here: what drives a socket is `TerminalStreamBridge`, an adapter, and a
   * route in `src/lib` may not import one. The mount decides who may stream and which terminal; the
   * composition root supplies the thing that turns pane bytes into frames.
   */
  stream(
    sessionId: string,
    terminalId: string,
    downstream: SocketDownstream,
    options?: { readonly reveal?: boolean },
  ): Promise<SocketHandler>;
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
  conflict: 409,
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

/** Who holds the open terminals across every session. */
async function holders(subsystem: TerminalSubsystem): Promise<ApiResponse> {
  return jsonResponse(await subsystem.holders().catch(reraise));
}

/** Closes what finished ferrets left open, and says who held it. */
async function closeFinished(subsystem: TerminalSubsystem): Promise<ApiResponse> {
  return jsonResponse(await subsystem.closeFinished('owner').catch(reraise));
}

/** Every terminal the session owns, with the limits the caller is being held to. */
async function list(subsystem: TerminalSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  return jsonResponse(await subsystem.list(sessionId).catch(reraise));
}

/**
 * Opens one terminal in the session's own working directory, and records who opened it.
 *
 * OWNERSHIP IS DECIDED HERE BECAUSE THIS IS WHERE THE CREDENTIAL IS. `context.credential` is
 * server-derived — the dispatcher sets it from the token that authenticated the request — so a class
 * derived from it is evidence, while anything read out of the body would be a claim. The refusal
 * matters as much as the derivation: a paired device that names an agent owner is answered 403
 * rather than silently recorded as a human, because a reader who consults ownership before typing
 * into a shell is owed a refusal instead of a plausible wrong answer.
 */
async function create(subsystem: TerminalSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  // Every field is optional, so an empty body means "open me a terminal, you choose" rather than a
  // malformed request — which is exactly what a PWA button sends.
  const request = await parseOptionalBody(context.request, CreateTerminalRequestSchema);
  const decision = decideTerminalOpener(context.credential, request.agentSessionId);
  if (decision.outcome === 'refused') throw new ApiError(403, decision.reason, 'forbidden');
  const opened =
    decision.outcome === 'attributed'
      ? await subsystem.create(sessionId, request, decision.openedBy).catch(reraise)
      : await subsystem.create(sessionId, request).catch(reraise);
  return jsonResponse(opened, 201);
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
      path: '/v1/terminals',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async () => await holders(subsystem),
    },
    {
      method: 'POST',
      path: '/v1/terminals/close-finished',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async () => await closeFinished(subsystem),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/terminals',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => await list(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/terminals',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => await create(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/terminals/:terminalId',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => await detail(subsystem, context),
    },
    {
      method: 'PATCH',
      path: '/v1/sessions/:sessionId/terminals/:terminalId',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => await rename(subsystem, context),
    },
    {
      method: 'DELETE',
      path: '/v1/sessions/:sessionId/terminals/:terminalId',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'terminal', axis: 'use' },
      noStore: true,
      handle: async context => await close(subsystem, context),
    },
  ];
}

/**
 * Terminal input and output, over the socket transport the protocol always described for them.
 *
 * `admin` scope, for the same reason the lifecycle is: this socket carries keystrokes into an
 * unsupervised shell, which is strictly more authority than opening one. A warden-scoped token
 * judges sessions and may not type into them.
 *
 * AUTHORIZATION AND EXISTENCE ARE BOTH PROVEN BEFORE THE SWITCH. `accept` runs on the authenticated
 * request, and it reads the terminal through `get` — the same lookup the detail route serves — so an
 * upgrade aimed at a terminal that was never opened, or at a session this daemon does not hold, is
 * refused with the 404 a viewer can act on. Switching protocols first and closing afterwards would
 * hand a client a close code that cannot tell "it is gone" from "the daemon broke", and would let an
 * unauthenticated peer probe which terminals exist by timing how fast the socket dies.
 */
export function terminalSocketRoutes(
  subsystem: TerminalSubsystem,
  quarantine?: Pick<InputRequestService, 'revealed'>,
): readonly SocketRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/terminals/:terminalId/stream',
      minimum: 'operator',
      caller: 'any',
      capability: { capability: 'terminal', axis: 'use' },
      accept: async context => {
        const sessionId = pathSessionId(context);
        const terminalId = pathTerminalId(context);
        await subsystem.get(sessionId, terminalId).catch(reraise);
        const reveal = quarantine !== undefined && context.request.query.get('reveal')?.[0] === '1';
        if (reveal) await quarantine.revealed(ownerOf(context), sessionId, terminalId).catch(answered);
        return async downstream => await subsystem.stream(sessionId, terminalId, downstream, { reveal });
      },
    },
  ];
}

/**
 * The security log's rules for the terminal surface. Opening a terminal records the session; typing into the session's
 * own pane from the Console is counted on the session and folded per window, exactly as a terminal socket's
 * keystrokes are — the request body is never read.
 */
const TERMINAL_AUDIT_RULES: readonly AuditedRouteRule[] = [
  { method: 'POST', path: '/v1/sessions/:sessionId/terminals', event: 'terminal.opened', subject: 'sessionId' },
  // Typing into the session's own pane from the Console: counted on the session and folded per window,
  // exactly as a terminal socket's keystrokes are — the request body is never read.
  {
    method: 'POST',
    path: '/v1/sessions/:sessionId/console/input',
    event: 'terminal.input',
    subject: 'sessionId',
    detail: { mode: 'console' },
  },
];

/** The terminal stream socket: opening it is recorded, and so is each binary frame typed into it (folded, never captured). */
const TERMINAL_AUDIT_SOCKETS: readonly AuditedSocketRule[] = [
  {
    path: '/v1/sessions/:sessionId/terminals/:terminalId/stream',
    event: 'terminal.opened',
    subject: 'terminalId',
    inputEvent: 'terminal.input',
  },
];

/** What the terminal module serves: the shell terminals, and the Console's input into a session's own pane. */
export interface TerminalSubsystems {
  readonly terminals: TerminalSubsystem;
  readonly sessionConsole: SessionConsoleSubsystem;
  readonly sessions: SessionDirectorySubsystem;
  /** The quarantine a stream's `reveal` is checked against. */
  readonly inputRequests: Pick<InputRequestService, 'revealed'>;
}

/**
 * What the terminal module adds to the daemon: the terminal lifecycle routes, the Console input route, the terminal
 * stream socket, and their audit rules. It claims no protocol feature.
 *
 * Every path is a literal no other subsystem uses (`/v1/terminals`) or sits under `/v1/sessions/:sessionId` ending in
 * `terminals…` or `console/input`, so none can shadow or be shadowed.
 */
export function terminalsContribution(subsystems: TerminalSubsystems): ModuleContribution {
  return {
    routes: [
      ...terminalRoutes(subsystems.terminals),
      ...sessionConsoleRoutes(subsystems.sessionConsole, subsystems.sessions),
    ],
    sockets: terminalSocketRoutes(subsystems.terminals, subsystems.inputRequests),
    audit: { routes: TERMINAL_AUDIT_RULES, sockets: TERMINAL_AUDIT_SOCKETS },
  };
}
