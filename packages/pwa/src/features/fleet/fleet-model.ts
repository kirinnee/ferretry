/**
 * The daemon-scoped vocabulary the fleet surfaces share: which harnesses exist, what each is called,
 * and which one is the default.
 *
 * It used to also carry `FleetAccountView` and `FleetReadState` — the read model of the deleted
 * `fleet-surface.tsx`. Both are gone with it, and nothing is left behind on purpose: an account as a
 * surface renders one is now `accounts-model.ts`, projected from the routes the daemon actually
 * serves, and a second account shape with no reader would only be there to drift.
 */

export type FleetHarnessKind = 'claude' | 'codex';

export interface FleetHarnessView {
  readonly kind: FleetHarnessKind;
  /** Wrapper names the daemon could resolve on this host right now. */
  readonly launchable: readonly string[];
  /** Published accounts that could not be launched, with daemon evidence. */
  readonly blocked: readonly string[];
}

/**
 * The owner's default rule lives in the fleet domain so the host CLI and this
 * daemon-scoped read model cannot drift. Callers provide only positive evidence.
 */
export { defaultFleetHarness } from '@ferretry/fleet/harness';

export const fleetHarnessLabel = (harness: FleetHarnessKind): 'Claude' | 'Codex' =>
  harness === 'claude' ? 'Claude' : 'Codex';
