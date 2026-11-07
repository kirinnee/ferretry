import { CAPABILITIES, grantRefusalCode, STEP_UP_ACTS, STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { ApiError, type CallContext, type CapabilityDemand } from '@ferretry/kernel/contract';

const RESTORE_DEMAND: CapabilityDemand = { capability: CAPABILITIES.fleet, axis: 'configure' };

/** Today's session-resume.confirmRestore. Called under the lifecycle gate only when restoring a durable cut-off. */
export function confirmRestore(call: CallContext, agent: boolean): () => void {
  return () => {
    if (agent) throw new ApiError(403, 'only the owner brings back a ferret it cut off', 'owner_only');
    const governance = call.governance;
    if (governance === undefined)
      throw new ApiError(
        403,
        'this daemon cannot say whether this device may bring back a cut-off ferret',
        'grant_undetermined',
      );
    if (!governance.governed) return;
    const decision = governance.decide(RESTORE_DEMAND);
    if (!decision.allowed && decision.refusal !== 'step-up-required')
      throw new ApiError(
        403,
        'bringing back a ferret you cut off needs this device to be allowed to change the fleet (fleet configure)',
        grantRefusalCode(decision.refusal),
      );
    if (call.claimFreshStepUp?.(STEP_UP_ACTS.resumeCutOff) !== true)
      throw new ApiError(
        403,
        'bringing back a ferret you cut off needs a passkey confirmation for it, from this device',
        STEP_UP_REQUIRED_CODE,
        undefined,
        { demand: { ...RESTORE_DEMAND, act: STEP_UP_ACTS.resumeCutOff } },
      );
  };
}
