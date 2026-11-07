import { ApiError, jsonResponse, type PlainApiResponse } from '@ferretry/kernel/contract';
import { markProofClaimed } from './claimed-standings.ts';
import { STEP_UP_REQUIRED_CODE, type StepUpRequiredBody } from './policy.ts';
import {
  type ApiActor,
  type AuthenticatedCredential,
  type CallerGovernance,
  type CapabilityPresentation,
  type ClaimFreshStepUp,
  isFerretCall,
} from './standing.ts';

/** The standing {@link ownerOnly} reads: who called, and whether a governed caller holds a fresh passkey proof. */
export interface OwnerOnlyCall {
  readonly credential?: AuthenticatedCredential;
  readonly actor?: ApiActor;
  readonly governance?: CallerGovernance;
  readonly presentation?: CapabilityPresentation;
  /** Takes the fresh proof atomically (Gate's `claimFreshStepUp`); read only by {@link claimOwnerOnly}. */
  readonly claimFreshStepUp?: ClaimFreshStepUp;
}

/**
 * Today's `ownerOnly` (packages/daemon/src/lib/runtime/mounts/daemon-update.ts), unchanged: the gate for putting new
 * code on this machine — the daemon's own update, turning automatic install on, and the agent CLIs' updates — so the
 * acts can never be governed differently.
 *
 * - A ferret is refused outright (`403 forbidden`, "a ferret cannot <act>; the owner does").
 * - A governed caller without a FRESH passkey proof is answered `403 grant_step_up_required` with the demand
 *   `{ fleet, configure }`.
 * - Otherwise (`undefined`) the act may go on. The acts themselves go through {@link claimOwnerOnly}, which also TAKES a
 *   governed caller's fresh proof before the act runs.
 */
export function ownerOnly(call: OwnerOnlyCall, act: string): PlainApiResponse | undefined {
  if (isFerretCall(call)) throw new ApiError(403, `a ferret cannot ${act}; the owner does`, 'forbidden');
  if (call.governance?.governed !== true || call.presentation?.freshStepUp === true) return undefined;
  return stepUpDemand(act);
}

/** The `403 grant_step_up_required` a governed caller without a fresh proof is answered, demanding `fleet.configure`. */
const stepUpDemand = (act: string): PlainApiResponse =>
  jsonResponse(
    {
      error: `to ${act} from this device, confirm with a passkey`,
      code: STEP_UP_REQUIRED_CODE,
      demand: { capability: 'fleet', axis: 'configure' },
    } satisfies StepUpRequiredBody,
    403,
  );

/**
 * {@link ownerOnly}, then — for a governed caller — the fresh proof CLAIMED before the act runs, as today's claim-first
 * routes do (`runtime/mounts/secrets.ts:831`, `context.claimFreshStepUp?.(…) === true` before the seed is saved).
 *
 * `presentation.freshStepUp` is a snapshot taken at admission, so two requests admitted on ONE proof would both pass
 * {@link ownerOnly}. The claim is atomic (Access's `claimFresh`: of concurrent acts on one proof exactly one is answered
 * `true`), so exactly one act runs and the other is answered the same `403 grant_step_up_required`. One proof admits
 * one act: there is no restore, so an act that then fails (a 409, 422 or 503, or a throw) has used the proof up, and the
 * person confirms again. A caller with no claim at all (no proved device) is refused: fail closed.
 *
 * The owner at the machine is ungoverned and claims nothing; a ferret is refused by {@link ownerOnly} first.
 */
export function claimOwnerOnly(call: OwnerOnlyCall, act: string): PlainApiResponse | undefined {
  const refused = ownerOnly(call, act);
  if (refused !== undefined || call.governance?.governed !== true) return refused;
  const claim = call.claimFreshStepUp;
  if (claim?.() !== true) return stepUpDemand(act);
  // Gate's config judge accepts this standing without taking a second proof (the act's own loosening write rides on
  // THIS claim): one proof, one act. The mark is Gate-private (`claimed-standings.ts`).
  markProofClaimed(claim);
  return undefined;
}
