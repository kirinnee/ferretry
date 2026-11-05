import { type CapabilityGrant, type CapabilityGrants, type DaemonCapability } from '@ferretry/protocol';
import { grantChanges } from './policy.ts';
import type { EnforcedGrants, GrantAuditEntry, GrantAuditPort, GrantClock } from './types.ts';

/**
 * THE ONE-TIME BOOT REPAIR A NEW CAPABILITY MAY EARN, written once (docs/grants.md, "Capability eight was added:
 * `sharing`" and "Capability nine was added: `voice`").
 *
 * A capability added after a device was paired is filled in OFF for that device, the narrowing rule, and a device can
 * only turn on what it already holds, so only the machine could ever turn it on. For a capability the owner decided
 * must start without a command at the machine, ONE widening is made, at boot: a device that held EVERY capability
 * that existed before it — what pairing gave a device by default, the owner's phone — gets the new one too, exactly
 * what it would hold if it were paired today. Nothing else is widened.
 *
 * The decision is data ({@link FollowsPairingSpec}), not code, so Sharing's repair and Voice's cannot drift apart:
 *
 * - `heldBefore` is NAMED, never computed as "every capability but this one". The set a device had to hold is a
 *   historical fact about the release before the capability, and `DAEMON_CAPABILITIES` only ever grows: computing it
 *   would make every later capability silently stop an earlier repair from ever firing.
 * - `releasedAt` is when the capability shipped. A journal record naming the device at or after it means whoever
 *   changed the device saw the capability and decided.
 * - `ignoredActors` are repairs of OTHER capabilities. A sibling repair that ran earlier in the same boot wrote a
 *   record naming the device at a time after `releasedAt`; that is the daemon, not somebody deciding.
 *
 * A device is repaired only when ALL of these hold:
 *
 * - every `heldBefore` capability is fully on in its stored record, and the new capability is fully off;
 * - the daemon-wide document has Pairing fully on (the operator's "who may hand out access" gate), and is readable;
 * - no grant-journal record EVER names `<device>/<capability>.*` — a grant somebody set by hand is never undone;
 * - no grant-journal record, other than an ignored actor's, names the device at all at or after `releasedAt`.
 *
 * Each repair is recorded in the grant journal under the spec's actor, after its write, so it happens at most once
 * and the history says why. A device whose write landed but whose record failed is reported as such.
 *
 * IT FAILS CLOSED. The whole journal is read, never a tail window; a journal larger than the bound, or one with a
 * line or a file that will not read, repairs nothing.
 */
export interface FollowsPairingSpec {
  /** The capability this repair turns on. */
  readonly capability: DaemonCapability;
  /** The capabilities that existed before it, named explicitly: all must be fully on for a device to qualify. */
  readonly heldBefore: readonly DaemonCapability[];
  /** The journal actor each repair is recorded under. */
  readonly actor: string;
  /** When the capability shipped. Changes to a device from here on were made knowing it. */
  readonly releasedAt: string;
  /** Journal actors whose records name a device without being a decision about it (a sibling boot repair). */
  readonly ignoredActors?: readonly string[];
  /** The most journal this repair reads. Past it, nothing is repaired: a widening never rests on a guess. */
  readonly journalMaxBytes: number;
}

/** The device side the repair needs. `PairingService` satisfies it. */
export interface FollowsPairingDevices {
  devices(): Promise<readonly { readonly id: string; readonly grants: CapabilityGrants }[]>;
  setDeviceGrants(deviceId: string, grants: CapabilityGrants): Promise<boolean>;
}

/** Every record in the grant journal, or why it could not all be read. */
export type WholeJournal =
  | { readonly kind: 'read'; readonly entries: readonly GrantAuditEntry[]; readonly unreadable: number }
  | { readonly kind: 'too-large' };

export interface FollowsPairingJournal {
  readAll(maxBytes: number): Promise<WholeJournal>;
}

export interface FollowsPairingDeps {
  readonly devices: FollowsPairingDevices;
  /** The daemon-wide answer now; `undefined` when it could not be read, which repairs nothing. */
  readonly daemonWide: () => EnforcedGrants;
  readonly journal: FollowsPairingJournal;
  readonly audit: GrantAuditPort;
  readonly clock: GrantClock;
}

export type FollowsPairingOutcome =
  | {
      readonly kind: 'repaired';
      /** The capability turned on and recorded. */
      readonly deviceIds: readonly string[];
      /** Turned on, but the journal record failed: said at boot, so the owner knows. */
      readonly unrecorded: readonly string[];
      /** The write itself failed: nothing changed for these, and later devices were still tried. */
      readonly failed: readonly string[];
    }
  | {
      readonly kind: 'skipped';
      readonly reason: 'journal-too-large' | 'journal-unreadable' | 'grants-undetermined' | 'failed';
    };

const fullyOn = (grant: CapabilityGrant): boolean => grant.use && grant.configure;
const fullyOff = (grant: CapabilityGrant): boolean => !grant.use && !grant.configure;

/** A device that held everything before the capability existed, and the capability nothing. */
const isOldFullDevice = (spec: FollowsPairingSpec, grants: CapabilityGrants): boolean =>
  fullyOff(grants[spec.capability]) && spec.heldBefore.every(capability => fullyOn(grants[capability]));

/** The device a journal change names, or `undefined` for a daemon-wide change. */
const deviceOf = (change: string): { readonly id: string; readonly rest: string } | undefined => {
  const slash = change.indexOf('/');
  return slash > 0 ? { id: change.slice(0, slash), rest: change.slice(slash + 1) } : undefined;
};

/** The devices somebody decided about: the capability ever, or anything about them since it existed. */
const decided = (spec: FollowsPairingSpec, entries: readonly GrantAuditEntry[]): ReadonlySet<string> => {
  const since = Date.parse(spec.releasedAt);
  const ids = new Set<string>();
  for (const entry of entries) {
    const recent = Date.parse(entry.at) >= since && !(spec.ignoredActors ?? []).includes(entry.actor);
    for (const change of entry.changes) {
      const named = deviceOf(change);
      if (named !== undefined && (recent || named.rest.startsWith(`${spec.capability}.`))) ids.add(named.id);
    }
  }
  return ids;
};

/**
 * Turns the capability on for every old full device nobody decided about, recording each change. Run once at boot,
 * after pairing opens and before devices are served. Safe on every boot: a repaired device is no longer a candidate,
 * and its record keeps it from ever being one again.
 */
export async function repairCapabilityFromPairing(
  spec: FollowsPairingSpec,
  deps: FollowsPairingDeps,
): Promise<FollowsPairingOutcome> {
  const candidates = (await deps.devices.devices()).filter(device => isOldFullDevice(spec, device.grants));
  if (candidates.length === 0) return { kind: 'repaired', deviceIds: [], unrecorded: [], failed: [] };
  const daemonWide = deps.daemonWide();
  if (daemonWide === undefined) return { kind: 'skipped', reason: 'grants-undetermined' };
  if (!fullyOn(daemonWide.pairing)) return { kind: 'repaired', deviceIds: [], unrecorded: [], failed: [] };
  const journal = await deps.journal.readAll(spec.journalMaxBytes);
  if (journal.kind === 'too-large') return { kind: 'skipped', reason: 'journal-too-large' };
  if (journal.unreadable > 0) return { kind: 'skipped', reason: 'journal-unreadable' };
  const skip = decided(spec, journal.entries);
  const repaired: string[] = [];
  const unrecorded: string[] = [];
  const failed: string[] = [];
  for (const device of candidates) {
    if (skip.has(device.id)) continue;
    const next: CapabilityGrants = { ...device.grants, [spec.capability]: { use: true, configure: true } };
    let written: boolean;
    try {
      written = await deps.devices.setDeviceGrants(device.id, next);
    } catch {
      failed.push(device.id);
      continue;
    }
    if (!written) continue;
    try {
      // After the write, as every grant change is: a record never claims a change that did not land.
      await deps.audit.record({
        actor: spec.actor,
        changes: grantChanges(device.grants, next).map(change => `${device.id}/${change}`),
        at: new Date(deps.clock.nowMs()).toISOString(),
      });
      repaired.push(device.id);
    } catch {
      unrecorded.push(device.id);
    }
  }
  return { kind: 'repaired', deviceIds: repaired, unrecorded, failed };
}
