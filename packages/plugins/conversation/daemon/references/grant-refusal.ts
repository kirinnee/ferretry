import {
  describeGrantRefusal,
  grantRefusalCode,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/core-gate/contract';
import {
  type CallContext,
  type CapabilityDemand,
  errorResponse,
  jsonResponse,
  type PlainApiResponse,
} from '@ferretry/kernel/contract';

/** The binary's name in a refusal sentence that names a command (Gate says the same). */
const CLIENT_NAME = 'fy';

/**
 * Asks the caller's governance one more question and answers a refusal EXACTLY as Gate's admission answers the same
 * demand on a route that declares it (admission.ts, step 9): `403` with the grant refusal code and sentence, or the
 * `403 grant_step_up_required` body when a step-up is what is missing. Never a 502, never a bare 200 with nothing in it.
 *
 * A caller with no governance on its standing is refused (a daemon that cannot say what this caller may do does
 * nothing). A step-up the machine wants asked every time is spent at the decision, as admission spends it (G97).
 *
 * Returns `undefined` when the caller may.
 */
export function refusedDemand(call: CallContext, demand: CapabilityDemand): PlainApiResponse | undefined {
  const governance = call.governance;
  const decision = governance?.decide(demand) ?? { allowed: false, refusal: 'undetermined' as const };
  if (decision.allowed) {
    if (decision.steppedUp === true) call.spendStepUp?.();
    return undefined;
  }
  const message =
    describeGrantRefusal(demand, decision.refusal, CLIENT_NAME) ??
    `this daemon cannot say whether the UI may use ${demand.capability}, so it is refusing`;
  if (decision.refusal === 'step-up-required')
    return jsonResponse(
      {
        error: message,
        code: STEP_UP_REQUIRED_CODE,
        demand: { capability: demand.capability, axis: demand.axis },
      } as unknown as StepUpRequiredBody,
      403,
    );
  return errorResponse(403, message, grantRefusalCode(decision.refusal));
}
