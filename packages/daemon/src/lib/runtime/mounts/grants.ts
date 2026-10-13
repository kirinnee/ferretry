import {
  GRANT_AUDIT_MAX_ENTRIES,
  type GrantAuditView,
  type GrantsPatch,
  GrantsPatchSchema,
  type GrantsView,
  STEP_UP_REQUIRED_CODE,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { type CapabilityPresentation, NO_STEP_UP_WITNESS, type StepUpWitness } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import { arrivedOnHost } from '../../api/http.ts';
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
  'step-up-required': { status: 403, code: STEP_UP_REQUIRED_CODE },
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
 * `loopback` is `arrivedOnHost`'s answer — the carrier's proof, so neither a relayed hop nor a
 * remote caller forwarded through a locally bound proxy reads as local — and `stepUp` is the step-up
 * service's answer for the session's PROVEN device, the same witness the dispatcher consults. A
 * request with no device has not stepped up. Nothing is read from the body, and the actor decides
 * nothing: it is carried so a change can be attributed to whoever made it.
 */
function presentationOf(context: RouteContext, stepUps: StepUpWitness): CapabilityPresentation {
  // The boundary's own assembly when it made one — the same object every route decision used.
  if (context.presentation !== undefined) return context.presentation;
  const device = context.request.device;
  return {
    loopback: arrivedOnHost(context.request, context.credential?.tokenClass === 'admin'),
    adminToken: context.credential?.tokenClass === 'admin',
    actor: context.actor ?? 'unknown',
    stepUp: device !== undefined && stepUps.held(device),
  };
}

export function grantRoutes(
  subsystem: GrantSubsystem,
  stepUps: StepUpWitness = NO_STEP_UP_WITNESS,
): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/grants',
      // Any authenticated caller, including a warden: a subject of the decision must be able to read
      // the decision. It discloses no secret — booleans and reasons.
      minimum: 'authenticated',
      noStore: true,
      handle: async context => jsonResponse(subsystem.view(presentationOf(context, stepUps))),
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
      method: 'PATCH',
      path: '/v1/grants',
      minimum: 'operator',
      noStore: true,
      handle: async context =>
        jsonResponse(
          await subsystem
            .patch(await parseBody(context.request, GrantsPatchSchema), presentationOf(context, stepUps))
            .catch(refuse),
        ),
    },
  ];
}
