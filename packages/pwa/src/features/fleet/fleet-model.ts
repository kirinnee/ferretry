/**
 * A daemon-scoped projection of the accounts and wrappers that can run on one
 * host. This is intentionally a read model: provisioning and account editing
 * need their own authenticated mutation boundary.
 */
export type FleetHarnessKind = 'claude' | 'codex';

export interface FleetHarnessView {
  readonly kind: FleetHarnessKind;
  /** Wrapper names the daemon could resolve on this host right now. */
  readonly launchable: readonly string[];
  /** Published accounts that could not be launched, with daemon evidence. */
  readonly blocked: readonly string[];
}

export interface FleetAccountView {
  readonly id: string;
  readonly wrapper: string;
  readonly harness: FleetHarnessKind;
  readonly label: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

/** A positive snapshot is required before this surface can say a fleet is empty. */
export type FleetReadState =
  | {
      readonly kind: 'available';
      readonly harnesses: readonly FleetHarnessView[];
      readonly accounts: readonly FleetAccountView[];
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * The owner's default rule, kept in exactly one policy function:
 * default to Claude when it exists; otherwise default to Codex.
 *
 * Callers must pass only harnesses with positive daemon evidence. An empty or
 * missing report is not evidence that neither harness exists.
 */
export const defaultFleetHarness = (harnesses: readonly FleetHarnessView[]): FleetHarnessKind | undefined => {
  if (harnesses.some(harness => harness.kind === 'claude' && harness.launchable.length > 0)) return 'claude';
  if (harnesses.some(harness => harness.kind === 'codex' && harness.launchable.length > 0)) return 'codex';
  return undefined;
};

export const fleetHarnessLabel = (harness: FleetHarnessKind): 'Claude' | 'Codex' =>
  harness === 'claude' ? 'Claude' : 'Codex';
