import {
  GRANT_AUDIT_MAX_ENTRIES,
  GRANT_UNLOCK_TTL_SECONDS,
  GrantPasswordRequestSchema,
  type GrantAuditView,
  type GrantsPatch,
  GrantsPatchSchema,
  type GrantsView,
  GrantUnlockRequestSchema,
  type GrantUnlockView,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import type { CapabilityPresentation } from '../../api/capability.ts';
import { OPERATOR_UNLOCK_HEADER } from '../../api/dispatcher.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, headerValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { GrantError } from '../../grants/index.ts';
import type { UnlockOutcome } from '../../grants/types.ts';

/**
 * The grant surface: `/v1/grants`, `/v1/grants/unlock` and `/v1/grants/password`.
 *
 * ## NONE OF THESE ROUTES IS ITSELF CAPABILITY-GATED, AND THAT IS DELIBERATE
 *
 * The read exists so a UI can explain what it may not do BEFORE somebody clicks into it. Gating it
 * behind the very grants it reports would make a restricted UI unable to discover why it is
 * restricted, which is precisely the greyed-control-with-no-explanation dead end this feature exists
 * to remove. The write is not route-gated either, because "may this caller change the grant for X"
 * is a per-capability question the subsystem answers per capability in the patch — a route-level
 * demand could only name one.
 *
 * ## THE PASSWORD ROUTE IS `host` SCOPE
 *
 * Setting or clearing the operator password is the one action that decides whether the security layer
 * exists at all, so a remote caller must never reach it: a paired device that could clear the password
 * could remove its own gate. `host` is the host's admin token only — never a device, never a warden —
 * which is the same reasoning that already puts fleet authorization there.
 *
 * ## NOTHING HERE RETURNS A PASSWORD
 *
 * No route projects the password, its hash, its salt or its length. `passwordSet` is a boolean, and
 * that is the entire disclosure. This is the same use-never-read shape the secret store is built on:
 * the property holds because there is no getter to call, not because callers are trusted to behave.
 */
export interface GrantSubsystem {
  /** Who changed what, newest first. Ungated for the reason the read above is. */
  history(limit: number): Promise<GrantAuditView>;
  /**
   * Re-reads the operator's decision.
   *
   * Declared here even though no route calls it, because the COMPOSITION ROOT must call it before the
   * address is bound and a field the mount does not name is a field a substitute world can silently
   * omit. A daemon that has not read its own grants must not serve.
   */
  refresh(): Promise<void>;
  /** Whether the security layer is on for this machine. Never the password itself. */
  hasPassword(): boolean;
  view(presentation: CapabilityPresentation): GrantsView;
  unlock(password: string): Promise<UnlockOutcome>;
  patch(patch: GrantsPatch, presentation: CapabilityPresentation): Promise<GrantsView>;
  setPassword(password: string | undefined): Promise<void>;
}

const REFUSALS: Readonly<Record<'invalid' | 'forbidden' | 'unavailable', { status: number; code: string }>> = {
  invalid: { status: 400, code: 'invalid_request' },
  forbidden: { status: 403, code: 'grant_forbidden' },
  // 503 rather than 500: the daemon is working, it has lost the ANSWER, and the remedy is to repair
  // the document rather than to report a crash.
  unavailable: { status: 503, code: 'grants_undetermined' },
};

function refuse(error: unknown): never {
  if (error instanceof GrantError) {
    const refusal = REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  throw error;
}

/**
 * What the grant layer is told about the caller, assembled from server-derived evidence only.
 *
 * `loopback` is the transport's own account of where the socket came from — a relayed hop is never
 * loopback, whatever address it appears to carry — and the actor is what `resolveApiActor` already
 * derived. Neither is read from the body, and the actor decides nothing: it is carried so a change
 * can be attributed to whoever made it.
 */
function presentationOf(context: RouteContext): CapabilityPresentation {
  return {
    loopback: context.request.loopback,
    actor: context.actor ?? 'unknown',
    unlock: headerValue(context.request, OPERATOR_UNLOCK_HEADER),
  };
}

/**
 * One password attempt.
 *
 * THE REFUSAL SAYS HOW MANY TRIES ARE LEFT, because a limiter a person cannot see is a limiter that
 * looks like a broken daemon. It never says whether the password was close, long enough, or anything
 * else about it — the only two facts disclosed are "not this one" and "this many attempts remain".
 */
async function unlock(subsystem: GrantSubsystem, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, GrantUnlockRequestSchema);
  const outcome = await subsystem.unlock(request.password).catch(refuse);
  if (outcome.kind === 'unlocked') {
    const view: GrantUnlockView = {
      token: outcome.token,
      expiresAt: new Date(outcome.expiresAtMs).toISOString(),
      ttlSeconds: GRANT_UNLOCK_TTL_SECONDS,
    };
    return jsonResponse(view);
  }
  const refusal = outcome.refusal;
  if (refusal.reason === 'no-password')
    throw new ApiError(
      409,
      'this machine has no operator password, so there is nothing to unlock and nothing gating a change',
      'grant_no_password',
    );
  if (refusal.reason === 'rate-limited')
    throw new ApiError(
      429,
      `too many wrong operator passwords; this daemon is not checking any more until ${new Date(refusal.lockedUntilMs ?? 0).toISOString()}`,
      'grant_rate_limited',
    );
  throw new ApiError(
    401,
    `that is not this machine's operator password; ${String(refusal.attemptsRemaining)} attempt${refusal.attemptsRemaining === 1 ? '' : 's'} remaining before this daemon stops checking`,
    'grant_wrong_password',
  );
}

/**
 * Setting or clearing the operator password.
 *
 * The RESPONSE says only whether one is now set. Echoing anything else — a length, a masked form, a
 * fingerprint — would be the first crack in "never rendered back", and there is no version of that
 * information a client needs.
 */
async function setPassword(subsystem: GrantSubsystem, context: RouteContext): Promise<ApiResponse> {
  const body = await parseBody(context.request, GrantPasswordRequestSchema);
  await subsystem.setPassword(body.password).catch(refuse);
  return jsonResponse({ passwordSet: body.password !== undefined });
}

export function grantRoutes(subsystem: GrantSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/grants',
      // Any authenticated caller, including a warden: a subject of the decision must be able to read
      // the decision. It discloses no secret — booleans and reasons, never the password.
      minimum: 'authenticated',
      noStore: true,
      handle: async context => jsonResponse(subsystem.view(presentationOf(context))),
    },
    {
      method: 'GET',
      path: '/v1/grants/audit',
      // `admin` rather than the read's `warden`: this names DEVICES, and a capability-scoped warden
      // has no business learning which phones an operator has paired. It is not capability-gated for
      // the same reason the grant read is not — the caller who was refused is the one asking.
      minimum: 'operator',
      noStore: true,
      handle: async () => jsonResponse(await subsystem.history(GRANT_AUDIT_MAX_ENTRIES).catch(refuse)),
    },
    {
      method: 'POST',
      path: '/v1/grants/unlock',
      minimum: 'operator',
      noStore: true,
      handle: async context => await unlock(subsystem, context),
    },
    {
      method: 'PATCH',
      path: '/v1/grants',
      minimum: 'operator',
      noStore: true,
      handle: async context =>
        jsonResponse(
          await subsystem
            .patch(await parseBody(context.request, GrantsPatchSchema), presentationOf(context))
            .catch(refuse),
        ),
    },
    {
      method: 'PUT',
      path: '/v1/grants/password',
      // Setting the operator password is local, but a paired device on the same machine is still an
      // operator. Arrival and credential are separate facts, so the UI can explain this before a tap.
      minimum: 'operator',
      privilegedOnly: true,
      noStore: true,
      handle: async context => await setPassword(subsystem, context),
    },
  ];
}
