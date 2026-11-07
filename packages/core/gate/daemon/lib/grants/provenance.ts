import { CAPABILITY_NAMES, type CapabilityGrants, type CapabilityName } from '../../../contract/index.ts';

/**
 * Which capabilities the operator actually NAMED in `gate.yaml` (today's `DaemonConfig.writtenGrants`, G155).
 *
 * Read from the RAW document rather than the parsed one, because parsing has already replaced every omission with a
 * default — and an operator may legitimately write a value identical to one. A document with no `grants` key names
 * none: every capability's value is the product default.
 */
export function grantsNamedIn(document: unknown): readonly CapabilityName[] {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return [];
  const written = (document as { readonly grants?: unknown }).grants;
  if (typeof written !== 'object' || written === null || Array.isArray(written)) return [];
  return CAPABILITY_NAMES.filter(name => (written as Record<string, unknown>)[name] !== undefined);
}

/**
 * The provenance the PARSED grants can still prove, for a kernel that does not hand Gate the raw text yet.
 *
 * GAP (waiting on kernel `configFiles.read`): a parsed document cannot tell "named on" from "the `grants` key was
 * left out", so every capability on both axes reads as the default (which is what an absent key gives). Otherwise
 * the `grants` key was written: an axis that is on can only have come from the file (an omitted capability reads as
 * off), and an all-off capability is the file's narrowing whether it was named or left out.
 */
export function grantsProvenFrom(grants: CapabilityGrants | undefined): readonly CapabilityName[] {
  if (grants === undefined) return [];
  if (CAPABILITY_NAMES.every(name => grants[name].use && grants[name].configure)) return [];
  return CAPABILITY_NAMES;
}

/** The kernel's `ConfigFileRead` (rebuild/port-kernel), the fields provenance reads, copied name for name. */
export interface ConfigFileRead {
  readonly path: string;
  readonly exists: boolean;
  readonly text: string | undefined;
  readonly etag: string;
}

/**
 * The read half of the kernel's `ConfigFilesWriter` (`KernelPorts.configFiles`, Gate's alone, rebuild/port-kernel),
 * copied name for name. GAP (waiting on kernel): this kernel has no `configFiles`, so provenance falls back to
 * {@link grantsProvenFrom} until it lands.
 */
export interface ConfigFilesReader {
  read(target: {
    readonly plugin: string;
    readonly def: unknown;
    readonly name?: string;
  }): Promise<ConfigFileRead | undefined>;
}
