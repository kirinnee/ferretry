import { failureText, runCgroupCommand } from '../cgroups/apply.ts';
import { agentScopeCommand, sliceWeightCommand, VOICE_SLICE, voiceScopeName } from '../cgroups/scope.ts';
import type { CgroupCommandPort, CgroupHostFacts } from '../cgroups/ports.ts';
import type { VoiceRecognizerSet } from './ipc.ts';
import { voicePlacementSupport, voiceUnitLimits } from './policy.ts';
import type { VoicePlacement, VoiceWorkerHandle } from './ports.ts';

export interface VoiceLaunchPlan {
  readonly command: readonly string[];
  readonly placement: VoicePlacement;
}
const VOICE_CPU_WEIGHT = 200;
/** A refusal prepares a best-effort launch, never a false hard-cap claim. Nice is unchanged (D3). */
export async function planVoiceLaunch(input: {
  readonly host: CgroupHostFacts;
  readonly commands: CgroupCommandPort;
  readonly recognizers: VoiceRecognizerSet;
  readonly nonce: string;
  readonly command: readonly string[];
}): Promise<VoiceLaunchPlan> {
  const placement = voicePlacementSupport(input.host);
  if (!placement.hardCapped) return { command: input.command, placement };
  try {
    await runCgroupCommand(
      input.commands,
      sliceWeightCommand(VOICE_SLICE, VOICE_CPU_WEIGHT),
      'Could not weight speech slice.',
    );
    return {
      placement,
      command: agentScopeCommand({
        scope: voiceScopeName(input.nonce),
        slice: VOICE_SLICE,
        limits: voiceUnitLimits(input.host.cpus, input.recognizers),
        command: input.command,
      }),
    };
  } catch (error) {
    return { command: input.command, placement: { hardCapped: false, reason: failureText(error) } };
  }
}

/** The attempt port must reap a failed launch before rejecting; fallback then cannot overlap it. */
export async function launchPlacedVoiceWorker(
  plan: VoiceLaunchPlan,
  direct: readonly string[],
  attempt: (command: readonly string[], placement: VoicePlacement) => Promise<VoiceWorkerHandle>,
): Promise<VoiceWorkerHandle> {
  if (!plan.placement.hardCapped) return await attempt(direct, plan.placement);
  try {
    return await attempt(plan.command, plan.placement);
  } catch (error) {
    return await attempt(direct, { hardCapped: false, reason: failureText(error) });
  }
}
