import { type CapabilityGrant, type CapabilityGrants, DAEMON_CAPABILITIES } from '@ferretry/protocol';
import { grantChanges } from './policy.ts';
import type { EnforcedGrants, GrantAuditEntry, GrantAuditPort, GrantClock } from './types.ts';

/**
 * SHARING FOR AN OLD FULL DEVICE, once (docs/grants.md, "Capability eight was added: `sharing`"; owner decision
 * 2026-10-31: catalog sharing must start without a command at the machine).
 *
 * The upgrade that added `sharing` filled every stored device with Sharing OFF, the narrowing rule, and a device can
 * only turn on what it already holds, so only the machine could turn Sharing on. THIS IS A WIDENING the owner
 * approved, and it is kept as narrow as the ask: a device that held EVERY capability before Sharing existed — what
 * pairing gave a device by default, the owner's phone — gets Sharing too, exactly what it would hold if it were
 * paired today. Nothing else is widened.
 *
 * A device is repaired only when ALL of these hold:
 *
 * - every capability but Sharing is fully on in its stored record, and Sharing is fully off;
 * - the daemon-wide document has Pairing fully on (the operator's "who may hand out access" gate), and is readable;
 * - no grant-journal record EVER names `<device>/sharing.*` — a Sharing somebody set by hand is never undone;
 * - no grant-journal record names the device at all at or after {@link SHARING_RELEASED_AT}: once Sharing existed,
 *   whoever changed that device's grants saw it and decided (a `--limited` device widened by hand, say).
 *
 * Each repair is recorded in the grant journal under {@link SHARING_REPAIR_ACTOR}, after its write, so it happens at
 * most once and the history says why. A device whose write landed but whose record failed is reported as such.
 *
 * IT FAILS CLOSED. The whole journal is read, never a tail window; a journal larger than the bound, or one with a line
 * or a file that will not read, repairs nothing.
 */
export const SHARING_REPAIR_ACTOR = 'daemon:sharing-follows-pairing';

/** When the `sharing` capability shipped (#1171, released in v4.177.0): changes from here on saw it. */
export const SHARING_RELEASED_AT = '2026-10-31T15:54:08.000Z';

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
  /** The daemon-wide answer now; `undefined` when it could not be read, which repairs nothing. */
  readonly daemonWide: () => EnforcedGrants;
  readonly journal: SharingRepairJournal;
  readonly audit: GrantAuditPort;
  readonly clock: GrantClock;
}

export type SharingRepairOutcome =
  | {
      readonly kind: 'repaired';
      /** Sharing turned on and recorded. */
      readonly deviceIds: readonly string[];
      /** Sharing turned on, but the journal record failed: said at boot, so the owner knows. */
      readonly unrecorded: readonly string[];
    }
  | {
      readonly kind: 'skipped';
      readonly reason: 'journal-too-large' | 'journal-unreadable' | 'grants-undetermined' | 'failed';
    };

const fullyOn = (grant: CapabilityGrant): boolean => grant.use && grant.configure;
const fullyOff = (grant: CapabilityGrant): boolean => !grant.use && !grant.configure;

/** A device that held everything before Sharing existed, and Sharing nothing. */
const isOldFullDevice = (grants: CapabilityGrants): boolean =>
  fullyOff(grants.sharing) &&
  DAEMON_CAPABILITIES.filter(capability => capability !== 'sharing').every(capability => fullyOn(grants[capability]));

/** The device a journal change names, or `undefined` for a daemon-wide change. */
const deviceOf = (change: string): { readonly id: string; readonly rest: string } | undefined => {
  const slash = change.indexOf('/');
  return slash > 0 ? { id: change.slice(0, slash), rest: change.slice(slash + 1) } : undefined;
};

/** The devices somebody decided about: their Sharing ever, or anything about them since Sharing existed. */
const decided = (entries: readonly GrantAuditEntry[]): ReadonlySet<string> => {
  const since = Date.parse(SHARING_RELEASED_AT);
  const ids = new Set<string>();
  for (const entry of entries) {
    const recent = Date.parse(entry.at) >= since;
    for (const change of entry.changes) {
      const named = deviceOf(change);
      if (named !== undefined && (recent || named.rest.startsWith('sharing.'))) ids.add(named.id);
    }
  }
  return ids;
};

/**
 * Turns Sharing on for every old full device nobody decided about, recording each change. Run once at boot, after
 * pairing opens and before devices are served. Safe on every boot: a repaired device is no longer a candidate, and
 * its record keeps it from ever being one again.
 */
export async function repairSharingFromPairing(deps: SharingRepairDeps): Promise<SharingRepairOutcome> {
  const candidates = (await deps.devices.devices()).filter(device => isOldFullDevice(device.grants));
  if (candidates.length === 0) return { kind: 'repaired', deviceIds: [], unrecorded: [] };
  const daemonWide = deps.daemonWide();
  if (daemonWide === undefined) return { kind: 'skipped', reason: 'grants-undetermined' };
  if (!fullyOn(daemonWide.pairing)) return { kind: 'repaired', deviceIds: [], unrecorded: [] };
  const journal = await deps.journal.readAll(SHARING_REPAIR_JOURNAL_MAX_BYTES);
  if (journal.kind === 'too-large') return { kind: 'skipped', reason: 'journal-too-large' };
  if (journal.unreadable > 0) return { kind: 'skipped', reason: 'journal-unreadable' };
  const skip = decided(journal.entries);
  const repaired: string[] = [];
  const unrecorded: string[] = [];
  for (const device of candidates) {
    if (skip.has(device.id)) continue;
    const next: CapabilityGrants = { ...device.grants, sharing: { use: true, configure: true } };
    if (!(await deps.devices.setDeviceGrants(device.id, next))) continue;
    try {
      // After the write, as every grant change is: a record never claims a change that did not land.
      await deps.audit.record({
        actor: SHARING_REPAIR_ACTOR,
        changes: grantChanges(device.grants, next).map(change => `${device.id}/${change}`),
        at: new Date(deps.clock.nowMs()).toISOString(),
      });
      repaired.push(device.id);
    } catch {
      unrecorded.push(device.id);
    }
  }
  return { kind: 'repaired', deviceIds: repaired, unrecorded };
}
