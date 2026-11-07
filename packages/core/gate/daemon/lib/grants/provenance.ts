import { CAPABILITY_NAMES, type CapabilityName } from '../../../contract/index.ts';

/**
 * Which capabilities the operator actually NAMED in `gate.yaml` (today's `DaemonConfig.writtenGrants`, G155).
 *
 * Read from the RAW document (the kernel's `configFiles.read`) rather than the parsed one, because parsing has already
 * replaced every omission with a default — and an operator may legitimately write a value identical to one. A document
 * with no `grants` key names none: every capability's value is the product default.
 */
export function grantsNamedIn(document: unknown): readonly CapabilityName[] {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return [];
  const written = (document as { readonly grants?: unknown }).grants;
  if (typeof written !== 'object' || written === null || Array.isArray(written)) return [];
  return CAPABILITY_NAMES.filter(name => (written as Record<string, unknown>)[name] !== undefined);
}
