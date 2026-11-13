import { type CapabilityDemand, definePort, defineEvent } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { AuditDraft } from './audit.ts';
import type { GateConfig } from './gate-config.ts';
import { CAPABILITY_NOUNS, type GrantRefusal, coreCapabilityName } from './policy.ts';

/**
 * What other subsystems may ask Gate (§7.4): record an audit entry, and read the policy in effect. Admission itself
 * is the kernel-bound `AdmissionPort` (re-exported from this contract); nothing here can admit a call.
 */
export interface GateApi {
  /** Appends one record to `audit.jsonl`. Names and ids only; Gate stamps the time. */
  audit(draft: AuditDraft): Promise<void>;
  /** The `gate.yaml` in effect (its last good version), or `undefined` when undetermined: read as a refusal. */
  policy(): GateConfig | undefined;
}

export const GatePort = definePort<GateApi>('gate');

/** The policy in effect changed (`gate.yaml` accepted, a held loosening confirmed). A wake-up; read `policy()`. */
export const GatePolicyChanged = defineEvent('gate.policy-changed', z.strictObject({ generation: z.number().int() }));

/** Today's `describeGrantRefusal`: the sentence a refused governed call carries. */
export function describeGrantRefusal(
  demand: CapabilityDemand,
  refusal: Exclude<GrantRefusal, 'granted'>,
  clientName: string,
): string;
export function describeGrantRefusal(
  demand: CapabilityDemand,
  refusal: GrantRefusal,
  clientName: string,
): string | undefined;
export function describeGrantRefusal(
  demand: CapabilityDemand,
  refusal: GrantRefusal,
  clientName: string,
): string | undefined {
  if (refusal === 'granted') return undefined;
  const name: string = demand.capability;
  const core = coreCapabilityName(demand.capability);
  const noun = core === undefined ? name : CAPABILITY_NOUNS[core];
  if (refusal === 'undetermined')
    return `this daemon cannot say what it is allowed to do with ${noun}, so it is doing nothing with it. Its grant document could not be read as a complete decision — run \`${clientName} config read gate.yaml\` on the host to see and repair it.`;
  if (refusal === 'not-granted')
    return demand.axis === 'use'
      ? `the operator of this machine has not granted the UI the use of ${noun}. Grant it on the host with \`${clientName} daemon config set ${name} --use\`.`
      : `the operator of this machine has not granted the UI permission to change the settings for ${noun}. Grant it on the host with \`${clientName} daemon config set ${name} --configure\`.`;
  if (refusal === 'device-not-granted')
    return `this device has not been given ${demand.axis === 'use' ? 'the use of' : 'permission to change the settings for'} ${noun}. Grant it at the machine with \`${clientName} device grant <device> ${name} --${demand.axis}\`, or from a device that holds it and may manage devices.`;
  return demand.axis === 'use'
    ? `using ${noun} needs a passkey confirmation from this device.`
    : `changing the settings for ${noun} needs a passkey confirmation from this device.`;
}
