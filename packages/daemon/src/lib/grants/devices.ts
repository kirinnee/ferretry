import type { CapabilityGrants, DeviceGrantsPatch } from '@ferretry/protocol';
import type { CapabilityPresentation } from '../api/capability.ts';
import {
  applyDeviceGrantPatch,
  grantChanges,
  intersectGrants,
  isGovernedCaller,
  judgeDeviceGrantChange,
  widenableBy,
  widenedBy,
} from './policy.ts';
import { GrantError } from './service.ts';
import type { EnforcedGrants, GrantAuditPort, GrantClock } from './types.ts';

/** Where each paired device's own grants are held. `PairingService` satisfies it structurally. */
export interface DeviceGrantStore {
  /** The device's grants now, or nothing for a device that is unknown or revoked. */
  deviceGrants(deviceId: string): CapabilityGrants | undefined;
  /** Records a change, reporting whether the device was still there to change. */
  setDeviceGrants(deviceId: string, grants: CapabilityGrants): Promise<boolean>;
}

export interface DeviceGrantDeps {
  readonly devices: DeviceGrantStore;
  /** The daemon-wide answer, read at the moment of the change — the other half of `effective`. */
  readonly daemonWide: () => EnforcedGrants;
  readonly audit: GrantAuditPort;
  readonly clock: GrantClock;
  readonly clientName: string;
  /** Told after every change, so streams authorized under the old answer are asked again (L7). */
  readonly changed?: () => void;
}

/**
 * What one change ended as. `widened` is a change that gave the device something it did not hold, and
 * so spent the caller's fresh passkey proof; `not-found` is a device that is unknown or was revoked
 * meanwhile.
 */
export type DeviceGrantOutcome = 'changed' | 'widened' | 'not-found';

/**
 * Changing ONE paired device's grants (`docs/design/zero-trust.md` B5).
 *
 * ## WHO MAY WIDEN
 *
 * At the machine, anybody: a caller that arrived on the host already has it (B4). Remotely, only a
 * device that holds `pairing.configure` AND, effectively, the very axis it is granting — and that holds
 * a live passkey step-up. No device can grant what it does not hold, so nothing escalates: the most a
 * device can hand another is a copy of what it already has.
 *
 * ## WHO MAY NARROW
 *
 * Any governed caller with a live step-up, on any device, its own included — never harder than
 * widening. A remote warden has no device and can never step up, so it changes nothing here.
 *
 * ## ALL OR NOTHING
 *
 * The patch is judged field by field and refused WHOLE if any field widens illegally, before anything
 * is written. A half-applied change leaves a device in a state nobody asked for.
 */
export class DeviceGrantService {
  constructor(private readonly deps: DeviceGrantDeps) {}

  /**
   * What THIS caller may turn on for a device — every axis at the machine; for a governed device, what
   * {@link widenableBy} lists; nothing for a governed caller that is not a device.
   */
  mayWiden(presentation: CapabilityPresentation): CapabilityGrants {
    const hostLocal = !isGovernedCaller({ loopback: presentation.loopback });
    return widenableBy(hostLocal, hostLocal ? undefined : this.holder(presentation));
  }

  async change(
    deviceId: string,
    patch: DeviceGrantsPatch,
    presentation: CapabilityPresentation,
  ): Promise<DeviceGrantOutcome> {
    const current = this.deps.devices.deviceGrants(deviceId);
    if (current === undefined) return 'not-found';
    const hostLocal = !isGovernedCaller({ loopback: presentation.loopback });
    const next = applyDeviceGrantPatch(current, patch);
    const verdict = judgeDeviceGrantChange({
      current,
      next,
      hostLocal,
      stepUp: presentation.stepUp,
      freshStepUp: presentation.freshStepUp === true,
      holder: hostLocal ? undefined : this.holder(presentation),
    });
    if (verdict.kind === 'forbidden') {
      const [capability, axis] = (verdict.widened[0] ?? 'fleet.use').split('.');
      throw new GrantError(
        'forbidden',
        `${verdict.widened.join(', ')} can only be given to a device from the machine itself, or by a device that holds it and may manage devices. Run \`${this.deps.clientName} device grant ${deviceId} ${capability ?? 'fleet'} --${axis ?? 'use'}\` on the host.`,
      );
    }
    if (verdict.kind === 'widen-step-up-required')
      throw new GrantError(
        'widen-step-up-required',
        'giving another device more access needs a passkey confirmation for it, from this device.',
      );
    const changes = grantChanges(current, next).map(change => `${deviceId}/${change}`);
    if (changes.length === 0) return 'changed';
    if (!(await this.deps.devices.setDeviceGrants(deviceId, next))) return 'not-found';
    this.deps.changed?.();
    // AFTER the write, so a record never claims a change that did not reach the document; a failing
    // audit is not swallowed, for the reason `CapabilityGrantService.patch` gives.
    await this.deps.audit.record({
      actor: presentation.actor,
      changes,
      at: new Date(this.deps.clock.nowMs()).toISOString(),
    });
    return widenedBy(current, next).length > 0 ? 'widened' : 'changed';
  }

  /**
   * What a governed caller holds, effective: the daemon-wide answer AND its own device's. `undefined`
   * for a caller that is not a device, which holds nothing it could pass on. An unreadable daemon-wide
   * document refuses the change rather than guessing.
   */
  private holder(presentation: CapabilityPresentation): CapabilityGrants | undefined {
    const own = presentation.deviceGrants;
    if (own === undefined || own === null) return undefined;
    const daemonWide = this.deps.daemonWide();
    if (daemonWide === undefined)
      throw new GrantError(
        'unavailable',
        'this daemon could not read its capability grants, so it will not change them',
      );
    return intersectGrants(daemonWide, own);
  }
}
