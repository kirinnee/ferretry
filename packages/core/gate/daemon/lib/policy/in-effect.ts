import type { ConfigFileStatus } from '@ferretry/kernel/contract';
import { DEFAULT_GATE_CONFIG, type GateConfig } from '../../../contract/index.ts';

/** `gate.yaml` as the kernel's config port shows it. */
export interface GateConfigSource {
  /** The parsed file in effect, `undefined` when none is; throws when it cannot be read. */
  file(): GateConfig | undefined;
  /** The kernel's `ConfigPort.fileState(GateConfigFile)`: tells an absent file from an invalid one. */
  fileState(): ConfigFileStatus;
}

/**
 * The policy in effect, or `undefined` when it is UNDETERMINED (fail closed: every governed capability is refused,
 * G153, G154). Only an ABSENT file is the product default (G6, G152): a file that is there but not in effect, a file
 * whose state cannot be read, and a file that cannot be read are all undetermined — silence and damage differ.
 */
export function policyInEffect(source: GateConfigSource): GateConfig | undefined {
  let status: ConfigFileStatus;
  try {
    status = source.fileState();
  } catch {
    return undefined;
  }
  if (!status.inEffect && status.state !== 'absent') return undefined;
  let value: GateConfig | undefined;
  try {
    value = source.file();
  } catch {
    return undefined;
  }
  if (value !== undefined) return value;
  return status.state === 'absent' ? DEFAULT_GATE_CONFIG : undefined;
}
