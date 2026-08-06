/**
 * What the configuration asks for that this build does not do.
 *
 * The declaration belongs beside `FleetConfigSchema`; this module owns only the fleet-specific
 * refusal wording. See {@link UnimplementedFleetCapabilityError}.
 */
import type { UnimplementedCapability } from './unimplemented.ts';

/**
 * Raised when a configuration asks for a capability this build does not have.
 *
 * The message names every offending key at once — an operator fixing them one refusal at a time
 * would run `apply` five times to learn five things — and each line says what would have happened
 * and what happens instead, because "not implemented" alone leaves the reader where they were.
 */
export class UnimplementedFleetCapabilityError extends Error {
  constructor(readonly capabilities: readonly UnimplementedCapability[]) {
    super(
      [
        `the fleet configuration asks for ${capabilities.length === 1 ? 'a capability' : 'capabilities'} this build does not implement:`,
        ...capabilities.map(item => `  ${item.key} — ${item.capability}; without it, ${item.consequence}`),
        'Remove or disable the listed keys to apply. They are refused rather than ignored so a fleet is never told it has something it does not.',
      ].join('\n'),
    );
    this.name = 'UnimplementedFleetCapabilityError';
  }
}
