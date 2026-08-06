import { ResumeSessionRequestSchema, type SessionView } from '@ferretry/protocol';
import { parseActor, type ApiActor } from '../../api/actor.ts';
import { parseOptionalBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { ResumeActorSchema, type ResumeActor } from '../../session/resume/index.ts';

/**
 * Reviving a stopped or dead session with its conversation intact: `POST /v1/sessions/:sessionId/resume`.
 *
 * `SessionResumeService` and its six adapters were built and tested for exactly this and never
 * called: `buildWorld` published `createSessionResume` as a world field, no mounted subsystem asked
 * for it, and the daemon answered `unknown_route` to the route the protocol client's `resume` already
 * speaks. A session that stopped was therefore a session the product could not get back — the state
 * home held its whole conversation and nothing could hand it a next turn.
 *
 * WHY THE ACTOR DECIDES THE POLICY RATHER THAN THE BODY. `resolveResumePolicy` gives an operator and
 * an automated reviver deliberately different privileges: only the automatic path may be suppressed
 * by the duplicate-work heuristic, and only an explicit one may clear the human-attention quarantine
 * a person has not yet seen. `ResumeSessionRequest` carries no actor field, and it must not gain one —
 * a caller that named its own actor would be choosing its own privileges. The value used here is the
 * one `resolveApiActor` already derived at the authorization boundary from the TOKEN CLASS and the
 * calling pane's own session id, which no request body participates in.
 *
 * AN UNRECOGNISED ACTOR RESOLVES TO `unknown`, which `resolveResumePolicy` treats as the safer
 * automatic path. That is the whole point of routing it through the schema rather than casting: a new
 * actor kind added to `resolveApiActor` gets the LESS powerful policy until someone deliberately
 * teaches the resume domain about it, instead of silently inheriting an operator's.
 *
 * WHY THE ANSWER IS A SESSION VIEW AND NOT THE OUTCOME. `ResumeOutcome.disposition` distinguishes a
 * message typed into a live pane from a full relaunch, and the wire shape the client parses is
 * `SessionView` — so the disposition is not reported. It is not lost either: every disposition is a
 * journalled transition on the session's own record, and the view answers with the status, turn and
 * activity instant that transition produced.
 */

/** Why a resume could not be performed. */
export type SessionResumeFailure =
  /** The id is not one the state-home layout would accept, so it must never become a path. */
  | 'invalid'
  /** No such session. */
  | 'not_found'
  /** The session's own condition refuses the revive — it is already running, or holds a question. */
  | 'refused'
  /** The session moved out from under the caller that scheduled this resume. */
  | 'guard_failed'
  /** The duplicate-work heuristic suppressed an AUTOMATIC revive. Never raised against an operator. */
  | 'suppressed'
  /** The relaunch was attempted and failed with no retry left. The session records why. */
  | 'failed';

/** A refusal raised by the composition root's reviver, in a taxonomy `src/lib` may name. */
export class SessionResumeError extends Error {
  constructor(
    readonly failure: SessionResumeFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionResumeError';
  }
}

/**
 * Reviving one session.
 *
 * The actor is passed IN rather than read from the request here, because it is the API's own derived
 * identity and the subsystem is what turns it into a policy — see the header. A message is optional
 * for the reason the domain models: an interactive session revived with no message just gets its
 * terminal back, while an auto session gets the default resume prompt.
 */
export interface SessionResumeSubsystem {
  resume(sessionId: string, actor: ResumeActor, message: string | undefined): Promise<SessionView>;
}

/** The HTTP status and code each refusal answers with. */
const REFUSALS: Readonly<Record<SessionResumeFailure, { readonly status: number; readonly code: string }>> = {
  invalid: { status: 400, code: 'invalid_session_id' },
  not_found: { status: 404, code: 'not-found' },
  refused: { status: 409, code: 'resume_refused' },
  guard_failed: { status: 409, code: 'resume_guard_failed' },
  suppressed: { status: 409, code: 'revive_suppressed' },
  failed: { status: 500, code: 'session_resume_failed' },
};

/** Restates a revive refusal in the HTTP vocabulary. */
function refuse(error: unknown): never {
  if (error instanceof SessionResumeError) {
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
 * Who asked, in the resume domain's own vocabulary.
 *
 * `resolveApiActor` produces `admin-cli`, `admin-ui`, `peer:<id>` or `warden:<id>`, and the domain
 * names the KIND only — a policy does not depend on which peer asked. Anything the domain does not
 * recognise, including the absent actor a `public` route would carry, becomes `unknown`.
 */
export function resumeActorOf(actor: ApiActor | undefined): ResumeActor {
  const parsed = ResumeActorSchema.safeParse(parseActor(actor ?? '').kind);
  return parsed.success ? parsed.data : 'unknown';
}

/** Revives a session, or answers a stated refusal. */
async function resume(subsystem: SessionResumeSubsystem, context: RouteContext): Promise<ApiResponse> {
  const sessionId = pathSessionId(context);
  const request = await parseOptionalBody(context.request, ResumeSessionRequestSchema);
  const view = await subsystem.resume(sessionId, resumeActorOf(context.actor), request.message).catch(refuse);
  return jsonResponse(view);
}

/**
 * `admin` scope, for the same reason a start and a stop are: a revive relaunches a process holding
 * the daemon's own privileges. The domain does model a WARDEN reviver, and that path stays open —
 * `resumeActorOf` maps a warden's own actor onto the automatic policy — but a warden TOKEN does not
 * get to relaunch an agent over HTTP until a unit decides that deliberately, so this fails closed.
 *
 * `noStore` because the answer is a live session view: status, turn and last activity are exactly
 * what changed, and a cached one shows the session as it was before the revive.
 */
export function sessionResumeRoutes(subsystem: SessionResumeSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/resume',
      scope: 'admin',
      minimum: 'operator',
      noStore: true,
      handle: async context => await resume(subsystem, context),
    },
  ];
}
