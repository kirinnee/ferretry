import { CAPABILITIES, grantRefusalCode, STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { ApiError, type CallContext, type CapabilityDemand } from '@ferretry/kernel/contract';

/** A plain `fleet.configure`: unlike the start's own demand it is NOT `promptsAsUse`, so a governed device is asked for a passkey. */
const COPY_DEMAND: CapabilityDemand = { capability: CAPABILITIES.fleet, axis: 'configure' };

/**
 * A start that names a past conversation has the owner's computer history COPIED into the harness's pool. Starting a ferret
 * is a prompt only where a use would be (`promptsAsUse`), so a device the owner left unprompted could pull computer history
 * in with no confirmation at all; the copy is its own act and asks for the step-up itself. Whoever is at the machine is
 * ungoverned and is not asked. Judged before anything is written, so a refusal leaves nothing behind.
 */
export function conversationCopyRefusal(call: CallContext, request: { readonly harnessConversation?: string }): void {
  if (request.harnessConversation === undefined) return;
  const presentation = call.presentation;
  if (presentation === undefined)
    throw new ApiError(503, 'this daemon cannot determine the launch caller standing', 'launch_gate_unavailable');
  if (presentation.local) return;
  if (call.governance === undefined)
    throw new ApiError(503, 'this daemon cannot decide fleet.configure for the copy', 'launch_gate_unavailable');
  const decision = call.governance.decide(COPY_DEMAND);
  if (decision.allowed) {
    call.spendStepUp?.();
    return;
  }
  throw new ApiError(
    403,
    "continuing a conversation copies it in from the owner's computer, which needs a passkey confirmation for the copy",
    decision.refusal === 'step-up-required' ? STEP_UP_REQUIRED_CODE : grantRefusalCode(decision.refusal),
    undefined,
    decision.refusal === 'step-up-required' ? { demand: COPY_DEMAND } : undefined,
  );
}
