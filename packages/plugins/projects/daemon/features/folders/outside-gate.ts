import { grantRefusalCode, STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { ApiError, type CallContext } from '@ferretry/kernel/contract';
import { filesystemConfigure } from '../../../contract/index.ts';

/**
 * The gate on browsing a place OUTSIDE the owner's home (owner decision D3): it is `filesystem.configure`, so a remote device
 * needs the passkey step-up that registering a project already needs, and a `--limited` or use-only device cannot map the
 * disk. The caller at the machine with the admin token is ungoverned and passes. Home browsing stays `filesystem.use`, which
 * the route itself declares.
 *
 * Returns what `folderPolicy` asks, once per request, before it says anything about a real path outside the home. A call
 * with no standing (a daemon that cannot decide) is refused: a place outside the home is never read on a guess.
 */
export const outsideHomeGate =
  (call: CallContext): (() => Promise<void>) =>
  async () => {
    if (call.governance === undefined)
      throw new ApiError(
        503,
        'this daemon cannot decide filesystem.configure for a folder outside the home',
        'folder_gate_unavailable',
      );
    const decision = call.governance.decide(filesystemConfigure);
    if (decision.allowed) {
      // A step-up the machine wants asked every time is spent at the decision, as admission spends it.
      if (decision.steppedUp === true) call.spendStepUp?.();
      return;
    }
    const stepUp = decision.refusal === 'step-up-required';
    throw new ApiError(
      403,
      'listing a folder outside the home folder needs filesystem.configure',
      stepUp ? STEP_UP_REQUIRED_CODE : grantRefusalCode(decision.refusal),
      undefined,
      stepUp ? { demand: filesystemConfigure } : undefined,
    );
  };
