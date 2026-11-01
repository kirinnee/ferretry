import {
  GRANT_AUDIT_MAX_ENTRIES,
  type GrantAuditView,
  type GrantsPatch,
  GrantsPatchSchema,
  type GrantsView,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { type CapabilityPresentation, grantRefusalCode } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import { GrantError, type GrantFailure } from '../../grants/index.ts';

/**
 * The grant surface: `/v1/grants` and its audit.
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
 * ## A GOVERNED WRITE NEEDS THE PASSKEY STEP-UP
 *
 * The refusal carries `grant_step_up_required`, the same code the authorization boundary emits, so
 * the browser's one retry-after-confirmation path covers this route without a special case.
 */
export interface GrantSubsystem {
  /** Who changed what, newest first. Open to every operator for the reason the read above is. */
  history(limit: number): Promise<GrantAuditView>;
  /**
   * Re-reads the operator's decision.
   *
   * Declared here even though no route calls it, because the COMPOSITION ROOT must call it before the
   * address is bound and a field the mount does not name is a field a substitute world can silently
   * omit. A daemon that has not read its own grants must not serve.
   */
  refresh(): Promise<void>;
  view(presentation: CapabilityPresentation): GrantsView;
  patch(patch: GrantsPatch, presentation: CapabilityPresentation): Promise<GrantsView>;
}

const REFUSALS: Readonly<Record<GrantFailure, { status: number; code: string }>> = {
  invalid: { status: 400, code: 'invalid_request' },
  forbidden: { status: 403, code: 'grant_forbidden' },
  // The wire code every other device-narrowed refusal uses, so the app's guidance for it applies here too.
  'device-not-granted': { status: 403, code: grantRefusalCode('device-not-granted') },
  'step-up-required': { status: 403, code: STEP_UP_REQUIRED_CODE },
  'widen-step-up-required': { status: 403, code: STEP_UP_REQUIRED_CODE },
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
 * What the grant layer is told about the caller: the authorization boundary's own assembly, the same
 * object every route decision for this request was made with (`arrivedOnHost`'s locality, the step-up
 * for the session's PROVEN device, and that device's own grants). A handler that rebuilt it would be a
 * second, quieter definition of locality; a request that arrived without one is a wiring mistake and is
 * refused rather than described by a guess.
 */
function presentationOf(context: RouteContext): CapabilityPresentation {
  if (context.presentation === undefined)
    throw new ApiError(500, 'this daemon cannot say who is asking, so it is refusing', 'internal_error');
  return context.presentation;
}

export function grantRoutes(subsystem: GrantSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/grants',
      // Any authenticated caller, including a warden: a subject of the decision must be able to read
      // the decision. It discloses no secret — booleans and reasons.
      minimum: 'authenticated',
      caller: 'any',
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
      caller: 'any',
      noStore: true,
      handle: async () => jsonResponse(await subsystem.history(GRANT_AUDIT_MAX_ENTRIES).catch(refuse)),
    },
    {
      method: 'PATCH',
      path: '/v1/grants',
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      handle: async context => {
        const view = await subsystem
          .patch(await parseBody(context.request, GrantsPatchSchema), presentationOf(context))
          .catch(refuse);
        // This route asks for its step-up itself rather than at the boundary, so it spends it itself: a
        // machine that asks every time must not let one confirmation change the grants twice.
        context.spendStepUp?.();
        return jsonResponse(view);
      },
    },
  ];
}
