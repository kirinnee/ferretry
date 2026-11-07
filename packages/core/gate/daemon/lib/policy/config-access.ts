import {
  type ApiResponse,
  type ConfigAccessJudgement,
  type ConfigAccessVerdict,
  errorResponse,
  jsonResponse,
} from '@ferretry/kernel/contract';
import {
  CAPABILITIES,
  type CapabilityName,
  grantRefusalCode,
  isFerretCall,
  OWNER_ONLY_CODE,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '../../../contract/index.ts';

/** The file whose own capability is `warden`; every other config file is the fleet's (today's `configFileCapability`). */
const WARDEN_FILE = 'warden.yaml';

const FLEET_USE = { capability: CAPABILITIES.fleet, axis: 'use' } as const;

const capabilityOf = (path: string): CapabilityName => (path === WARDEN_FILE ? 'warden' : 'fleet');

/** The `403 grant_step_up_required` body, naming the act when it is one confirmed on its own. */
function stepUpRefusal(message: string, capability: CapabilityName, loosen: boolean): ApiResponse {
  return jsonResponse(
    {
      error: message,
      code: STEP_UP_REQUIRED_CODE,
      demand: { capability, axis: 'configure', ...(loosen ? { act: STEP_UP_ACTS.loosenConfig } : {}) },
    } as unknown as StepUpRequiredBody,
    403,
  );
}

const refuse = (response: ApiResponse): ConfigAccessVerdict => ({ allowed: false, response });

/**
 * Gate's judge of the kernel's config routes (`Admission.judgeConfigAccess`, today's `mounts/config-files.ts`): the
 * FILE's own capability — `warden` for `warden.yaml`, `fleet` for everything else — on the axis the act needs, never an
 * agent for an act that changes, and a loosening put into effect in the same act only for somebody at this machine or a
 * device with a passkey proved for the act.
 *
 * - `read`: the file's capability on `use`.
 * - `write`: its `configure`, then the fleet's `use` (a device the owner kept off the fleet may change no file); the
 *   verdict says whether this call may put a loosening into effect (`mayLoosen`) and carries the proof to spend if it
 *   did (`spend`, present only for a governed caller).
 * - `confirm`: the same asks, and — from a governed device — a passkey proved for THIS act (`loosen-config`), spent
 *   once the edit is in effect.
 *
 * Anything undetermined (no standing, no grant standing) refuses.
 */
export function judgeConfigAccess(input: ConfigAccessJudgement): ConfigAccessVerdict {
  const { path, act } = input;
  const standing = input.standing;
  const governance = standing?.governance;
  if (standing === undefined || governance === undefined)
    return refuse(
      jsonResponse(
        {
          error:
            act === 'read'
              ? `this daemon could not check whether this caller may read ${path} on this route, which is a daemon bug (update it: fy daemon update)`
              : `nothing was changed: this daemon could not check what this caller may do with ${path} on this route, which is a daemon bug (update it: fy daemon update); meanwhile, at the machine, fy config confirm ${path} confirms it`,
          code: 'forbidden',
        },
        403,
      ),
    );
  if (act !== 'read' && (input.actor === 'ferret' || input.actor === 'warden' || isFerretCall(standing))) {
    return refuse(
      errorResponse(
        403,
        act === 'write'
          ? `only a person may use PUT /v1/config/file; a ferret writes a config file with config_write, where the owner turned "Ferretry settings" on`
          : 'an agent cannot confirm a configuration change; the owner confirms it',
        act === 'write' ? OWNER_ONLY_CODE : 'forbidden',
      ),
    );
  }
  const capability = capabilityOf(path);
  const axis = act === 'read' ? 'use' : 'configure';
  const decision = governance.decide({ capability: CAPABILITIES[capability], axis });
  if (!decision.allowed) {
    if (decision.refusal === 'step-up-required')
      return refuse(stepUpRefusal(`changing ${path} from this device needs a passkey confirmation`, capability, false));
    return refuse(
      errorResponse(
        403,
        `this device may not ${act === 'read' ? 'read' : 'change'} ${path}`,
        grantRefusalCode(decision.refusal),
      ),
    );
  }
  if (act === 'read') return { allowed: true };
  const fleet = governance.decide(FLEET_USE);
  if (!fleet.allowed)
    return refuse(
      errorResponse(
        403,
        `this device may not use the agent fleet, so it may not change ${path}`,
        grantRefusalCode(fleet.refusal),
      ),
    );
  const fresh = standing.presentation?.freshStepUp === true;
  const spend = governance.governed && standing.spendFreshStepUp !== undefined ? standing.spendFreshStepUp : undefined;
  if (act === 'write')
    return { allowed: true, mayLoosen: !governance.governed || fresh, ...(spend === undefined ? {} : { spend }) };
  if (governance.governed && !fresh)
    return refuse(
      stepUpRefusal(`putting this change to ${path} into effect needs a passkey confirmation for it`, capability, true),
    );
  return { allowed: true, ...(spend === undefined ? {} : { spend }) };
}
