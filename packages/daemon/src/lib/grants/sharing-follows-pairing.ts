import type { CapabilityGrant, CapabilityGrants } from '@ferretry/protocol';
import { grantChanges } from './policy.ts';
import type { GrantAuditEntry, GrantAuditPort, GrantClock } from './types.ts';

/**
 * SHARING FOLLOWS PAIRING, for a device paired before Sharing existed (docs/grants.md, "Capability eight
 * was added: `sharing`"; owner decision 2026-10-31: catalog sharing must start without a command at the
 * machine).
 *
 * The upgrade that added `sharing` filled every stored device with Sharing OFF — the narrowing rule — and a
 * device can only turn on, for any device, what it already holds. So no device could ever turn Sharing on,
 * and the owner had to go to the machine. But PAIRING is the strictly stronger power: it hands another
 * device CONTROL of this machine, where Sharing hands people READ access to chosen catalogs. A device that
 * holds Pairing could already give a new device everything, Sharing included. So a device that holds
 * Pairing on both axes gets Sharing on both axes: nothing it could not already have arranged.
 *
 * WHO IS REPAIRED: a device whose Pairing is on (use and configure), whose Sharing is fully off, and whose
 * Sharing NOBODY EVER SET — no grant-journal record names `<device>/sharing.*`. An owner who turned a device's
 * Sharing off on purpose is recorded, and is never undone here. Each repair is recorded too, under the
 * actor {@link SHARING_REPAIR_ACTOR}, so it happens at most once per device and the history says why.
 *
 * IT FAILS CLOSED. The whole journal is read, never a window of it, because a deliberate change older than
 * the window would look like no change. A journal larger than the bound, or one with a line it cannot read
 * (which might be that change), means no device is repaired, and the reason is answered for the boot trail.
 */
export const SHARING_REPAIR_ACTOR = 'daemon:sharing-follows-pairing';

/** The most journal this repair reads. Past it, nothing is repaired: a widening never rests on a guess. */
export const SHARING_REPAIR_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;

/** The device side the repair needs. `PairingService` satisfies it. */
export interface SharingRepairDevices {
  devices(): Promise<readonly { readonly id: string; readonly grants: CapabilityGrants }[]>;
  setDeviceGrants(deviceId: string, grants: CapabilityGrants): Promise<boolean>;
}

/** Every record in the grant journal, or why it could not all be read. */
export type WholeJournal =
  | { readonly kind: 'read'; readonly entries: readonly GrantAuditEntry[]; readonly unreadable: number }
  | { readonly kind: 'too-large' };

export interface SharingRepairJournal {
  readAll(maxBytes: number): Promise<WholeJournal>;
}

export interface SharingRepairDeps {
  readonly devices: SharingRepairDevices;
  readonly journal: SharingRepairJournal;
  readonly audit: GrantAuditPort;
  readonly clock: GrantClock;
}

export type SharingRepairOutcome =
  | { readonly kind: 'repaired'; readonly deviceIds: readonly string[] }
  | { readonly kind: 'skipped'; readonly reason: 'journal-too-large' | 'journal-unreadable' | 'failed' };

const fullyOn = (grant: CapabilityGrant): boolean => grant.use && grant.configure;
const fullyOff = (grant: CapabilityGrant): boolean => !grant.use && !grant.configure;

/** Whether a device is one this repair may touch at all, before the journal is read. */
const isCandidate = (grants: CapabilityGrants): boolean => fullyOn(grants.pairing) && fullyOff(grants.sharing);

/** The devices any journal record names a Sharing change for. */
const setByHand = (entries: readonly GrantAuditEntry[]): ReadonlySet<string> =>
  new Set(
    entries.flatMap(entry =>
      entry.changes.flatMap(change => {
        const slash = change.indexOf('/');
        return slash > 0 && change.slice(slash + 1).startsWith('sharing.') ? [change.slice(0, slash)] : [];
      }),
    ),
  );

/**
 * Turns Sharing on for every device that holds Pairing and whose Sharing nobody ever set, recording each
 * change. Run once at boot, after pairing opens and before devices are served. Safe to run on every boot:
 * a repaired device is no longer a candidate, and its record keeps it from ever being one again.
 */
export async function repairSharingFromPairing(deps: SharingRepairDeps): Promise<SharingRepairOutcome> {
  const candidates = (await deps.devices.devices()).filter(device => isCandidate(device.grants));
  if (candidates.length === 0) return { kind: 'repaired', deviceIds: [] };
  const journal = await deps.journal.readAll(SHARING_REPAIR_JOURNAL_MAX_BYTES);
  if (journal.kind === 'too-large') return { kind: 'skipped', reason: 'journal-too-large' };
  if (journal.unreadable > 0) return { kind: 'skipped', reason: 'journal-unreadable' };
  const touched = setByHand(journal.entries);
  const repaired: string[] = [];
  for (const device of candidates) {
    if (touched.has(device.id)) continue;
    const next: CapabilityGrants = { ...device.grants, sharing: { use: true, configure: true } };
    if (!(await deps.devices.setDeviceGrants(device.id, next))) continue;
    // After the write, as every grant change is: a record never claims a change that did not land.
    await deps.audit.record({
      actor: SHARING_REPAIR_ACTOR,
      changes: grantChanges(device.grants, next).map(change => `${device.id}/${change}`),
      at: new Date(deps.clock.nowMs()).toISOString(),
    });
    repaired.push(device.id);
  }
  return { kind: 'repaired', deviceIds: repaired };
}
