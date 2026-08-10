import {
  FY_REQUEST_ID_HEADER,
  type SessionHandoverFailure,
  type SessionHandoverReceipt,
  type SessionHandoverRequest,
  SessionHandoverRequestSchema,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiRequest, type ApiResponse, BodyTooLargeError, decodeParameter, headerValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { HandoverError } from '../../handover/types.ts';

/**
 * Handing a top-level session to a different harness: three routes under
 * `/v1/sessions/:sessionId/handover`.
 *
 * A HANDOVER IS NOT A MIGRATION, and this mount is the place that keeps the two words apart. A
 * migration keeps one session id and restamps its identity document so one conversation continues
 * under another account of the SAME family — see `session-migrate.ts`. A handover crosses families,
 * and the conversation is exactly the thing that cannot cross: the transcript, the turn counter, the
 * open-tool ids and the resume arguments are all the source harness's, and the target harness cannot
 * read any of them. So a handover starts a NEW top-level session, carries every durable coordination
 * fact into it, proves the replacement can act on the predecessor's board, and only then retires the
 * predecessor. The board and its tasks never move.
 *
 * THE DAEMON DRIVES IT, AND THE PROOF IS NOT A ROUTE. Every step up to the launch is daemon-driven,
 * and then the state machine WAITS for an inbound `invitation.verify` only the replacement's own pane
 * can reasonably make — because a proof the orchestrator could produce would prove only that the
 * orchestrator can write to a document, which nobody doubted. This mount exposes the three things a
 * caller may ask — begin it, read its durable receipt, cancel it before the point of no return — and
 * none of them is `verify`.
 *
 * THE RECEIPT IS THE ANSWER. A handover spans a create, four board writes, a launch, an inbound proof,
 * a coordinator succession and a stop, so a caller must be able to ask what happened at any phase. Both
 * POSTs answer 202 with the receipt at its CURRENT phase (the reconciler keeps advancing it after the
 * call returns), and the GET answers 200 with it; a terminal receipt stays inspectable through every
 * one of the three. `planId` is on every receipt the daemon returns, and `board` is required-and-
 * nullable so a reader never confuses a boardless root with a missing section.
 *
 * THE REFUSAL TABLE MAPS ONE PROTOCOL-OWNED SET. There is no second enumeration here: every
 * actionable cause the daemon can raise is `SessionHandoverFailure` from `@ferretry/protocol`, and the
 * table below exhaustively maps each one to the HTTP status and code a caller acts on. The terminal
 * CATEGORY (`refused` / `abandoned` / `stranded` / `failed`) lives on `receipt.phase`, not on the
 * failure code, so a `stranded` receipt still reads through GET with the specific cause that stranded
 * it on `refusal.failure`. The only failures this mount invents are the BOUNDARY ones a route owns in
 * every table: an unusable path id, a missing request id, and a body the schema refused — and each of
 * those is decided before the subsystem is reached, so the daemon's state is untouched.
 *
 * THE REQUEST ID IS MANDATORY ON BOTH POSTs, for the same reason the migration's is: the protocol
 * client retries a POST on transport failure, and a handover creates a session and changes board
 * membership. A request that cannot be recognised on its second arrival cannot be protected from
 * performing those effects twice, so the daemon refuses to begin or cancel one rather than accept a
 * caller's word that it will never retry.
 */

/**
 * What this mount calls to drive a handover.
 *
 * A port shaped here rather than a service class named in `src/lib`, so this route table never has to
 * import an adapter: the composition root constructs the real service and hands it to
 * `sessionHandoverRoutes`, and the surface tests hand it a fake. Each method returns the durable
 * receipt at its current phase and raises a {@link HandoverError} carrying a protocol
 * `SessionHandoverFailure` for every refusal — there is no `verify` here, and adding one is the one
 * change this mount must never make.
 */
export interface SessionHandoverSubsystem {
  /** Begins a handover, or refuses it before anything is created. Answers the receipt at its first
   *  phase; the reconciler advances it from there. The parsed POST body is passed through whole,
   *  because every field is a decision the daemon makes — which replacement agent, which model, which
   *  coordinator descendant and why — and none is a decision this mount may make on the caller's
   *  behalf. */
  begin(sessionId: string, request: SessionHandoverRequest, requestId: string): Promise<SessionHandoverReceipt>;
  /** Reads the durable receipt for a session at any phase, terminal included. Refuses `source_not_found`
   *  when no receipt exists, rather than answering an empty body that could be mistaken for one. */
  receipt(sessionId: string): Promise<SessionHandoverReceipt>;
  /** Cancels a handover that has not crossed the point of no return. Answers the receipt in its
   *  resulting terminal phase; past the point of no return there is nothing to cancel and the call
   *  refuses rather than pretending to undo. */
  cancel(sessionId: string, requestId: string): Promise<SessionHandoverReceipt>;
}

/** The HTTP status and code each protocol refusal cause answers with.
 *
 * Complete over `SessionHandoverFailure` on purpose: a cause the daemon newly raises lands as a
 * compile error here until the mount states what a caller should do with it, which is the difference
 * between an actionable surface and one that drops new refusals into a generic 500. The runtime and
 * drift causes (`verification_timeout`, `replacement_terminal`, `board_moved`, `plan_drifted`,
 * `step_failed`) are written to a terminal receipt by the reconciler rather than thrown at a caller,
 * so they most often reach a human through the GET; they are mapped anyway so a thrown instance is
 * never an unhandled shape. */
const REFUSALS: Readonly<Record<SessionHandoverFailure, { readonly status: number; readonly code: string }>> = {
  // Eligibility: the subject is not one this operation may begin on. 409 rather than 404 or 403,
  // because the session exists and the caller's request is well formed — it is the session's own
  // condition that answers, and the remedy is a different operation or a different session.
  not_top_level: { status: 409, code: 'not_top_level' },
  mode_not_invitable: { status: 409, code: 'mode_not_invitable' },
  no_live_coordinator: { status: 409, code: 'no_live_coordinator' },
  // THE COORDINATOR AND THE BOARD ARE ONE FACT: a coordinator is required exactly when the source is on
  // a board, and forbidden when it is not. This one cause answers BOTH directions of that iff.
  //
  // A board root that names none is refused because relinquish revokes every grant beneath the retiring
  // root — the old coordinator's included — so a board left without one could never approve anything
  // again. A BOARDLESS root that names one is refused too, and it is the same rule rather than a
  // leniency worth adding: dropping the coordinator silently would launch something other than what the
  // operator asked for, and honouring it would spawn a descendant nothing can ever seat, because there
  // is no board to seat it on.
  //
  // 409 and actionable in both readings: the caller either names the coordinator the replacement will be
  // seated with, or sends `coordinator: null` for a root that has no board.
  coordinator_required: { status: 409, code: 'coordinator_required' },
  // The target is the source's own family, so a handover would throw a transcript away for nothing;
  // the caller's remedy is `fy migrate`, which keeps the conversation. A different request, not a
  // different spelling of this one.
  harness_same: { status: 409, code: 'harness_same' },
  // One of the two families is a name this build does not recognise, so sameness cannot be proved
  // either way. Refused rather than guessed at, for the same reason the migration's family gate is.
  harness_unknown: { status: 409, code: 'harness_unknown' },
  // No such session (begin) or no receipt for one (GET). 404: there is nothing here to act on.
  source_not_found: { status: 404, code: 'not-found' },
  // This root already carries a terminal handover receipt; beginning another is a different request,
  // not a retry of the completed one.
  already_completed: { status: 409, code: 'already_completed' },
  // Another handover of this same root is already under way under a different request id. The same
  // request id replays the in-flight receipt rather than refusing.
  in_flight: { status: 409, code: 'in_flight' },
  // The request id was presented before, carrying a different target. A caller defect, not a retry.
  request_conflict: { status: 409, code: 'request_conflict' },
  // The board already carries an outstanding invitation the reducer would refuse a second one against.
  board_busy: { status: 409, code: 'board_busy' },
  // 403: a warden asked to hand over a board root, and widening board membership needs the explicit
  // invitation authority a warden's per-assignment capability does not carry. Forbidden, not merely
  // conflicting — the caller does not get to do this at all with that credential.
  board_authority_required: { status: 403, code: 'board_authority_required' },
  // The predecessor died mid-flight, killed by something outside this handover. DISTINCT from
  // `source_not_found`, which is the begin-time refusal that the subject never existed: this one names
  // a session that WAS live and was lost under way, and it is the only cause that may settle `failed`
  // before the retirement tail. 409 rather than 404 for exactly that reason — a handover happened, and
  // the receipt is the record of how far it got.
  source_lost: { status: 409, code: 'source_lost' },
  // The advisory gate at `requested`, or the binding gate at `draining`, found in-flight work it will
  // not destroy. 409, answerable: the caller waits for the work to finish or stops it and asks again.
  preflight_blocked: { status: 409, code: 'preflight_blocked' },
  // The four runtime/drift causes below are ordinarily written to a STRANDED receipt rather than
  // thrown at a caller; mapped so a thrown instance still answers with its cause.
  verification_timeout: { status: 409, code: 'verification_timeout' },
  replacement_terminal: { status: 409, code: 'replacement_terminal' },
  board_moved: { status: 409, code: 'board_moved' },
  // Re-preparing the transfer after a crash produced a different plan than the receipt recorded: an
  // internal inconsistency an operator must investigate, not a state a caller can retry past.
  plan_drifted: { status: 500, code: 'handover_plan_drifted' },
  // A step failed after the predecessor was already stopped. Like the migration's `failed`, the
  // destruction is behind it, so an automatic retry would act on a session with no predecessor left.
  step_failed: { status: 500, code: 'session_handover_failed' },
  // An operator cancelled before the point of no return; the receipt records it. 409 rather than 200
  // because the handover the caller began is no longer the one in flight.
  cancelled: { status: 409, code: 'cancelled' },
};

/** Restates a handover refusal in the HTTP vocabulary, and lets anything outside the taxonomy surface
 *  as itself rather than being dressed up as an actionable refusal. */
function refuse(error: unknown): never {
  if (error instanceof HandoverError) {
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
 * The logical request id this begin or cancel is identified by.
 *
 * MANDATORY, for the same reason the migration's is: the protocol client retries these POSTs on
 * transport failure, and a handover creates a session and changes board membership. A request that
 * cannot be recognised on its second arrival cannot be protected from performing those effects twice,
 * so the daemon refuses to begin or cancel one rather than accept a caller's word that it will never
 * retry.
 */
function requestId(request: ApiRequest): string {
  const value = headerValue(request, FY_REQUEST_ID_HEADER)?.trim() ?? '';
  if (value === '')
    throw new ApiError(
      400,
      `a handover must carry ${FY_REQUEST_ID_HEADER}: without it a retried request could create a second replacement or stop a predecessor twice`,
      'missing_request_id',
    );
  return value;
}

/** Begins a handover, or answers a stated refusal. 202 because the receipt is at its first phase and
 *  the reconciler keeps advancing it after this call returns. */
async function begin(subsystem: SessionHandoverSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const target = await parseBody(context.request, SessionHandoverRequestSchema);
  const id = requestId(context.request);
  const receipt = await subsystem.begin(sessionId, target, id).catch(refuse);
  return jsonResponse(receipt, 202);
}

/** Reads the durable receipt at any phase. Authenticated rather than operator-scoped, because a paired
 *  device checking what happened to a session is a reader, not an actor. */
async function read(subsystem: SessionHandoverSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const receipt = await subsystem.receipt(sessionId).catch(refuse);
  return jsonResponse(receipt);
}

/**
 * How much of a cancel body this route will read before refusing.
 *
 * A cancel's entire contract is `{}` or nothing, so the bound is stated in bytes rather than left to
 * the shared request ceiling: an operator-scoped POST that read an unbounded body would let a caller
 * make this daemon buffer megabytes to be told the only acceptable body was two characters. The read
 * is bounded BEFORE the string exists, which is the end of the allocation worth standing at, and the
 * value is generous enough that no honest client — `{}`, whitespace, a pretty-printed empty object —
 * can reach it.
 */
const MAX_CANCEL_BODY_BYTES = 1024;

/** A cancel carries no parameters, and the body is the PROOF it carries none: it must be empty or
 *  exactly `{}`. A cancel that silently accepted `{force: true}` would let a caller believe the
 *  no-force gate can be overridden through this route, so the route states the empty contract by
 *  refusing anything that is not empty — the same discipline that makes the begin body strict. There is
 *  no schema import here because there is nothing for a schema to describe but absence: a field is a
 *  second spelling of the request, and this route refuses to guess which one. */
/**
 * The cancel body, read under the bound above and refused in the daemon's shared vocabulary.
 *
 * The mapping is done here rather than left to the raw reader because this route does not go through
 * `parseBody` — it has no schema to apply — and an oversized body that escaped as a raw
 * `BodyTooLargeError` would reach the caller as a 500 describing a defect, when it is an ordinary,
 * caller-correctable refusal. 413 with the shared code is what every other bounded route answers, so a
 * client needs one branch rather than one per route.
 */
async function cancelBodyText(request: ApiRequest): Promise<string> {
  try {
    return await request.text(MAX_CANCEL_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new ApiError(413, error.message, 'body_too_large');
    throw new ApiError(400, 'the request body could not be read', 'unreadable_body');
  }
}

function assertEmptyCancelBody(body: string): void {
  const trimmed = body.trim();
  if (trimmed === '') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ApiError(400, 'a cancel body must be empty or {}', 'invalid_body');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'a cancel carries no parameters: send an empty body', 'invalid_body');
  }
  if (Object.keys(parsed).length !== 0) {
    throw new ApiError(400, 'a cancel carries no parameters: send an empty body', 'invalid_body');
  }
}

/** Cancels an in-flight handover. The request id names the cancellation (and protects a retried cancel
 *  from running twice); the body is checked empty so a second spelling is rejected rather than ignored.
 * Answers 202 with the receipt in its resulting terminal phase. */
async function cancel(subsystem: SessionHandoverSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  assertEmptyCancelBody(await cancelBodyText(context.request));
  const id = requestId(context.request);
  const receipt = await subsystem.cancel(sessionId, id).catch(refuse);
  return jsonResponse(receipt, 202);
}

/**
 * The handover surface.
 *
 * Both POSTs are `operator` scope, for the same reason the migrate is: a handover creates a privileged
 * session and changes board membership. The GET is `authenticated`, because reading what happened is a
 * lesser thing than causing it, and a paired device may do the former where it may not do the latter.
 *
 * `noStore` on every route, because a receipt's phase advances under the reconciler and a cached one
 * would freeze a live handover at the phase a stale response happened to capture.
 */
export function sessionHandoverRoutes(subsystem: SessionHandoverSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/handover',
      minimum: 'operator',
      noStore: true,
      handle: async context => await begin(subsystem, context),
    },
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/handover',
      minimum: 'authenticated',
      noStore: true,
      handle: async context => await read(subsystem, context),
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/handover/cancel',
      minimum: 'operator',
      noStore: true,
      handle: async context => await cancel(subsystem, context),
    },
  ];
}
