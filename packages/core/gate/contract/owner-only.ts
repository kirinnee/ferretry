import { ApiError, jsonResponse, type PlainApiResponse } from '@ferretry/kernel/contract';
import { STEP_UP_REQUIRED_CODE, type StepUpRequiredBody } from './policy.ts';
import {
  type ApiActor,
  type AuthenticatedCredential,
  type CallerGovernance,
  type CapabilityPresentation,
  isFerretCall,
} from './standing.ts';

/** The standing {@link ownerOnly} reads: who called, and whether a governed caller holds a fresh passkey proof. */
export interface OwnerOnlyCall {
  readonly credential?: AuthenticatedCredential;
  readonly actor?: ApiActor;
  readonly governance?: CallerGovernance;
  readonly presentation?: CapabilityPresentation;
}

/**
 * Today's `ownerOnly` (packages/daemon/src/lib/runtime/mounts/daemon-update.ts), unchanged: the gate for putting new
 * code on this machine — the daemon's own update, turning automatic install on, and the agent CLIs' updates — so the
 * acts can never be governed differently.
 *
 * - A ferret is refused outright (`403 forbidden`, "a ferret cannot <act>; the owner does").
 * - A governed caller without a FRESH passkey proof is answered `403 grant_step_up_required` with the demand
 *   `{ fleet, configure }`.
 * - Otherwise (`undefined`) the act may go on. The caller then spends a governed caller's fresh proof only once the act
 *   has SUCCEEDED (`if (call.governance?.governed === true) call.spendFreshStepUp?.()`), so a refused act leaves it.
 */
export function ownerOnly(call: OwnerOnlyCall, act: string): PlainApiResponse | undefined {
  if (isFerretCall(call)) throw new ApiError(403, `a ferret cannot ${act}; the owner does`, 'forbidden');
  if (call.governance?.governed !== true || call.presentation?.freshStepUp === true) return undefined;
  return jsonResponse(
    {
      error: `to ${act} from this device, confirm with a passkey`,
      code: STEP_UP_REQUIRED_CODE,
      demand: { capability: 'fleet', axis: 'configure' },
    } satisfies StepUpRequiredBody,
    403,
  );
}
