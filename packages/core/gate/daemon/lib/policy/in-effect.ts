import { DEFAULT_GATE_CONFIG, type GateConfig } from '../../../contract/index.ts';

/**
 * Where one declared config file stands — the kernel's `ConfigFileStatus` (rebuild/port-kernel), copied name for name
 * so the swap is one import when that kernel lands: `invalid` with `inEffect: false` is a FIRST file that never
 * checked, which is damage, not defaults.
 */
export interface ConfigFileStatus {
  readonly state: 'absent' | 'valid' | 'invalid' | 'held';
  readonly inEffect: boolean;
  readonly sentences: readonly string[];
}

/** `gate.yaml` as the kernel's config port shows it. */
export interface GateConfigSource {
  /** The parsed file in effect, `undefined` when none is; throws when it cannot be read. */
  file(): GateConfig | undefined;
  /**
   * The kernel's `ConfigPort.fileState(GateConfigFile)`. GAP (waiting on kernel): this kernel's config port has no
   * `fileState` yet, so an invalid first `gate.yaml` (which its `file()` reports as `undefined`, like an absent one)
   * cannot be told from an absent one until it lands.
   */
  fileState?(): ConfigFileStatus;
}

/**
 * The policy in effect, or `undefined` when it is UNDETERMINED (fail closed: every governed capability is refused,
 * G153, G154). Only an ABSENT file is the product default (G6, G152): a file that is there but not in effect, a file
 * whose state cannot be read, and a file that cannot be read are all undetermined — silence and damage differ.
 */
export function policyInEffect(source: GateConfigSource): GateConfig | undefined {
  let status: ConfigFileStatus | undefined;
  try {
    status = source.fileState?.();
  } catch {
    return undefined;
  }
  if (status !== undefined && !status.inEffect && status.state !== 'absent') return undefined;
  let value: GateConfig | undefined;
  try {
    value = source.file();
  } catch {
    return undefined;
  }
  if (value !== undefined) return value;
  if (status !== undefined && status.state !== 'absent') return undefined;
  return DEFAULT_GATE_CONFIG;
}
