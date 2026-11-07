import { posix } from 'node:path';
import { CAPABILITIES, grantRefusalCode } from '@ferretry/core-gate/contract';
import { ApiError, type CallContext, type CapabilityDemand } from '@ferretry/kernel/contract';

const TERMINAL_USE: CapabilityDemand = { capability: CAPABILITIES.terminal, axis: 'use' };
const within = (path: string, root: string): boolean => {
  const target = posix.normalize(path);
  const base = posix.normalize(root).replace(/\/+$/u, '');
  return target === base || target.startsWith(`${base}/`);
};

/** Today's session-control.launchRefusal, using Gate's carrier-proved presentation and grant decision. */
export async function terminalLaunchRefusal(
  call: CallContext,
  request: { readonly folder: string; readonly options?: { readonly harnessFlags?: readonly string[] } },
  knownRoots: (() => Promise<readonly string[]>) | undefined,
): Promise<void> {
  const presentation = call.presentation;
  if (presentation === undefined)
    throw new ApiError(503, 'this daemon cannot determine the launch caller standing', 'launch_gate_unavailable');
  if (presentation.local) return;
  const flagged = (request.options?.harnessFlags ?? []).length > 0;
  if (!flagged && knownRoots === undefined)
    throw new ApiError(
      503,
      'known project roots are not bound, so this daemon cannot classify the launch',
      'launch_roots_unavailable',
    );
  const outside = !flagged && !(await knownRoots!()).some(root => within(request.folder, root));
  if (!flagged && !outside) return;
  if (call.governance === undefined)
    throw new ApiError(503, 'this daemon cannot decide terminal.use for the launch', 'launch_gate_unavailable');
  const decision = call.governance.decide(TERMINAL_USE);
  if (decision.allowed) {
    call.spendStepUp?.();
    return;
  }
  throw new ApiError(
    403,
    'starting an agent with its own flags, or outside every project, is terminal access',
    decision.refusal === 'step-up-required' ? 'step_up_required' : grantRefusalCode(decision.refusal),
    undefined,
    decision.refusal === 'step-up-required' ? { demand: TERMINAL_USE } : undefined,
  );
}
