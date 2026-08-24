/**
 * A daemon-scoped projection of the accounts and wrappers that can run on one
 * host. This is intentionally a read model: provisioning and account editing
 * need their own authenticated mutation boundary.
 */
import type { PickerAccountHealth } from '../../lib/account-picker-catalog.ts';

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
  /**
   * The host's stored health verdict, or absent when it published none for this
   * account.
   *
   * ABSENT IS NOT UNHEALTHY and it is not "unknown" either — it renders through
   * `UNREAD_ACCOUNT_HEALTH`, whose sentence is "nothing has checked this account
   * yet". An account whose ROW says `unknown` has its own reason, which might be
   * a timeout or Codex having no free proof, and those are different facts.
   *
   * Optional rather than required because this surface must keep rendering a
   * roster whose health read failed: a daemon that can list accounts and cannot
   * serve verdicts still has accounts.
   */
  readonly health?: PickerAccountHealth;
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
