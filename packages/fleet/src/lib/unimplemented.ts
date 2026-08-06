/**
 * Declarations for configuration a schema accepts but this build cannot honour.
 *
 * A schema owns its declaration beside the parser, then a boundary asks this pure helper for the
 * requested entries before it performs work. Keeping the declaration with the schema makes an
 * accepted-but-unhonoured setting visible to every caller instead of relying on a separate warning
 * path that can be forgotten.
 */

/** One thing a configuration asked for, and what its absence means for the caller. */
export interface UnimplementedCapability {
  /** Dotted path of the offending key, as an operator would find it in their file. */
  readonly key: string;
  /** What would happen if the key were honoured. */
  readonly capability: string;
  /** What the build does instead. Stated because it is the part that misleads. */
  readonly consequence: string;
}

/** One accepted setting that this build deliberately refuses to pretend it implements. */
export interface UnimplementedCapabilityCheck<Config> extends UnimplementedCapability {
  /** True when this parsed configuration is asking for the unavailable behaviour. */
  readonly requested: (config: Config) => boolean;
}

/** The accepted-but-unhonoured portion of one schema's public declaration. */
export interface SchemaCapabilityDeclaration<Config> {
  readonly unimplementedCapabilities: readonly UnimplementedCapabilityCheck<Config>[];
}

/**
 * Everything this parsed configuration asks for that the declaring schema cannot honour.
 *
 * An empty list is normal. A non-empty list is intentionally data rather than a warning so each
 * boundary can refuse, print, or otherwise make the mismatch visible in its own contract.
 */
export function unimplementedCapabilities<Config>(
  config: Config,
  declaration: SchemaCapabilityDeclaration<Config>,
): readonly UnimplementedCapability[] {
  return declaration.unimplementedCapabilities
    .filter(check => check.requested(config))
    .map(check => ({
      key: check.key,
      capability: check.capability,
      consequence: check.consequence,
    }));
}
