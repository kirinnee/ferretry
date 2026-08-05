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
 * The owner's default rule lives in the fleet domain so the host CLI and this
 * daemon-scoped read model cannot drift. Callers provide only positive evidence.
 */
export { defaultFleetHarness } from '@ferretry/fleet/harness';

export const fleetHarnessLabel = (harness: FleetHarnessKind): 'Claude' | 'Codex' =>
  harness === 'claude' ? 'Claude' : 'Codex';
