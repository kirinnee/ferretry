/**
 * What the operator's grants say about writing one configuration file (docs/grants.md, docs/config-files.md).
 *
 * `PUT /v1/config/file` asks the FILE's own capability — `warden` for `warden.yaml`, `fleet` for everything
 * else — on the axis the act needs. A copy from another machine (`clone.import`) writes the same files, so it
 * asks the very same question through the very same demand: a device that may not write `warden.yaml`
 * directly may not write it by copying, and a relayed browser is a governed device for both, because
 * "governed" is decided from how the request ARRIVED (docs/grants.md), never from an address.
 *
 * Pure: a demand in, a decision out.
 */
import { type ConfigFileAddress, classifyConfigPath, configFileCapability } from '@ferretry/protocol';
import type { CallerGovernance, CapabilityDemand } from '../api/capability.ts';

/** The demand for acting on `path`: its capability on `axis`. A path that is no configuration file is a fleet file. */
export function configFileDemand(
  path: string,
  axis: 'use' | 'configure',
  narrowing = false,
): CapabilityDemand & { readonly capability: 'fleet' | 'warden' } {
  const address = classifyConfigPath(path) as ConfigFileAddress | undefined;
  return {
    capability: address === undefined ? 'fleet' : configFileCapability(address),
    axis,
    ...(narrowing ? { narrowing: true as const } : {}),
  };
}

/**
 * Why this caller may not copy settings into `path`, in words: `undefined` when it may, or when it only needs a
 * passkey the apply asks for.
 *
 * A review shows what this machine's file holds, so the file is READ-checked too: a device kept off
 * `warden.yaml` learns nothing of it through a copy either.
 */
export function configFileWriteRefusal(
  governance: CallerGovernance | undefined,
  path: string,
  stage: 'describe' | 'apply',
): string | undefined {
  if (governance === undefined) {
    return `this daemon could not check whether this caller may change ${path}, which is a daemon bug (update it: fy daemon update); nothing was changed`;
  }
  const reading = governance.decide(configFileDemand(path, 'use'));
  const writing = governance.decide(configFileDemand(path, 'configure'));
  for (const [decision, what] of [
    [writing, 'change'],
    [reading, 'read'],
  ] as const) {
    if (decision.allowed) continue;
    if (decision.refusal === 'step-up-required') {
      // Staging describes the copy and writes nothing; the apply is where the passkey is asked for.
      if (stage === 'apply') return `changing ${path} from this device needs a passkey confirmation`;
      continue;
    }
    return `this device may not ${what} ${path}`;
  }
  return undefined;
}
