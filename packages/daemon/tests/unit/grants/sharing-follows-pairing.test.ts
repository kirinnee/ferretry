import { describe, it } from 'bun:test';
import { type CapabilityGrants, FULL_DEVICE_GRANTS, LIMITED_DEVICE_GRANTS } from '@ferretry/protocol';
import should from 'should';
import {
  DEFAULT_CAPABILITY_GRANTS,
  type EnforcedGrants,
  type GrantAuditEntry,
  repairSharingFromPairing,
  SHARING_RELEASED_AT,
  SHARING_REPAIR_ACTOR,
  SHARING_REPAIR_JOURNAL_MAX_BYTES,
  type WholeJournal,
} from '../../../src/lib/index.ts';

const PHONE = 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa';
const TABLET = 'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb';
const LAPTOP = 'fy_device_id_cccccccccccccccccccccc';
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const BEFORE = '2026-10-20T00:00:00.000Z';
const AFTER = '2026-11-01T00:00:00.000Z';
const OFF = { use: false, configure: false };
const ON = { use: true, configure: true };

/** The owner's phone as the upgrade left it: everything it held before Sharing existed, Sharing filled off. */
const oldFull = (): CapabilityGrants => ({ ...FULL_DEVICE_GRANTS, sharing: OFF });

interface Rig {
  devices?: Record<string, CapabilityGrants>;
  journal?: WholeJournal;
  /** `'unknown'` stands for an unreadable daemon-wide answer; a plain `undefined` would read as the default. */
  daemonWide?: EnforcedGrants | 'unknown';
  recordFails?: boolean;
}

function rig({
  devices = { [PHONE]: oldFull() },
  journal = { kind: 'read', entries: [], unreadable: 0 },
  daemonWide = DEFAULT_CAPABILITY_GRANTS,
  recordFails = false,
}: Rig = {}) {
  const stored = new Map(Object.entries(devices));
  const recorded: GrantAuditEntry[] = [];
  let reads = 0;
  const deps = {
    devices: {
      devices: async () => [...stored].map(([id, grants]) => ({ id, grants })),
      setDeviceGrants: async (id: string, grants: CapabilityGrants) => {
        if (!stored.has(id)) return false;
        stored.set(id, grants);
        return true;
      },
    },
    daemonWide: (): EnforcedGrants => (daemonWide === 'unknown' ? undefined : daemonWide),
    journal: {
      readAll: async (maxBytes: number) => {
        reads += 1;
        should(maxBytes).equal(SHARING_REPAIR_JOURNAL_MAX_BYTES);
        return journal;
      },
    },
    audit: {
      record: async (entry: GrantAuditEntry) => {
        if (recordFails) throw new Error('disk full');
        recorded.push(entry);
      },
      recent: async () => ({ entries: [], unreadable: 0, truncated: false }),
    },
    clock: { nowMs: () => NOW },
  };
  return { deps, stored, recorded, reads: () => reads };
}

const journalOf = (...entries: GrantAuditEntry[]): WholeJournal => ({ kind: 'read', entries, unreadable: 0 });

describe('Sharing for a device that held everything before Sharing existed', () => {
  it('turns Sharing on for an old full device, and records it under its own actor', async () => {
    const { deps, stored, recorded } = rig();

    const outcome = await repairSharingFromPairing(deps);

    should(outcome).deepEqual({ kind: 'repaired', deviceIds: [PHONE], unrecorded: [], failed: [] });
    should(stored.get(PHONE)?.sharing).deepEqual(ON);
    should(recorded).deepEqual([
      {
        actor: SHARING_REPAIR_ACTOR,
        changes: [`${PHONE}/sharing.use=on`, `${PHONE}/sharing.configure=on`],
        at: '2026-11-01T12:00:00.000Z',
      },
    ]);
  });

  it('never widens a device that lacked any other capability, held Pairing or not, nor one with any Sharing', async () => {
    const pairingOnly: CapabilityGrants = { ...LIMITED_DEVICE_GRANTS, pairing: ON, sharing: OFF };
    const { deps, stored, reads } = rig({
      devices: {
        [TABLET]: { ...LIMITED_DEVICE_GRANTS, sharing: OFF },
        [LAPTOP]: pairingOnly,
        [PHONE]: { ...oldFull(), sharing: { use: true, configure: false } },
      },
    });

    should(await repairSharingFromPairing(deps)).deepEqual({
      kind: 'repaired',
      deviceIds: [],
      unrecorded: [],
      failed: [],
    });
    should(stored.get(LAPTOP)?.sharing).deepEqual(OFF);
    should(stored.get(TABLET)?.sharing).deepEqual(OFF);
    // No candidate, so neither the daemon-wide answer nor the journal is read: an ordinary boot costs nothing.
    should(reads()).equal(0);
  });

  it('repairs nothing when the daemon-wide Pairing is off, and says so when the daemon-wide answer is unknown', async () => {
    const pairingOff = rig({ daemonWide: { ...DEFAULT_CAPABILITY_GRANTS, pairing: { use: true, configure: false } } });
    should(await repairSharingFromPairing(pairingOff.deps)).deepEqual({
      kind: 'repaired',
      deviceIds: [],
      unrecorded: [],
      failed: [],
    });
    should(pairingOff.stored.get(PHONE)?.sharing).deepEqual(OFF);

    const unknown = rig({ daemonWide: 'unknown' });
    should(await repairSharingFromPairing(unknown.deps)).deepEqual({ kind: 'skipped', reason: 'grants-undetermined' });
    should(unknown.stored.get(PHONE)?.sharing).deepEqual(OFF);
  });

  it('never undoes a Sharing set by hand, however long ago, nor touches a device changed since Sharing existed', async () => {
    const journal = journalOf(
      { actor: 'admin-cli', changes: [`${PHONE}/sharing.use=off`], at: BEFORE },
      // A --limited device widened by hand after Sharing existed: whoever did it saw Sharing and decided.
      { actor: 'device:x', changes: [`${TABLET}/terminal.use=on`], at: AFTER },
      // Before Sharing existed, a change to another capability decides nothing about Sharing.
      { actor: 'admin-cli', changes: [`${LAPTOP}/terminal.use=on`], at: BEFORE },
      // A daemon-wide change names no device.
      { actor: 'admin-ui', changes: ['sharing.use=off'], at: AFTER },
    );
    const { deps, stored } = rig({
      devices: { [PHONE]: oldFull(), [TABLET]: oldFull(), [LAPTOP]: oldFull() },
      journal,
    });

    should(await repairSharingFromPairing(deps)).deepEqual({
      kind: 'repaired',
      deviceIds: [LAPTOP],
      unrecorded: [],
      failed: [],
    });
    should(stored.get(PHONE)?.sharing).deepEqual(OFF);
    should(stored.get(TABLET)?.sharing).deepEqual(OFF);
    should(stored.get(LAPTOP)?.sharing).deepEqual(ON);
    should(SHARING_RELEASED_AT < AFTER && SHARING_RELEASED_AT > BEFORE).be.true();
  });

  it('repairs a device at most once, because its own record marks it', async () => {
    const first = rig();
    await repairSharingFromPairing(first.deps);
    // The owner then turns the phone's Sharing off by hand; the next boot reads both records.
    const second = rig({ journal: journalOf(...first.recorded) });

    should(await repairSharingFromPairing(second.deps)).deepEqual({
      kind: 'repaired',
      deviceIds: [],
      unrecorded: [],
      failed: [],
    });
    should(second.stored.get(PHONE)?.sharing).deepEqual(OFF);
  });

  it('repairs nothing when the journal is too large to read whole, or holds a line it cannot read', async () => {
    for (const [journal, reason] of [
      [{ kind: 'too-large' }, 'journal-too-large'],
      [{ kind: 'read', entries: [], unreadable: 1 }, 'journal-unreadable'],
    ] as const) {
      const { deps, stored, recorded } = rig({ journal });

      should(await repairSharingFromPairing(deps)).deepEqual({ kind: 'skipped', reason });
      should(stored.get(PHONE)?.sharing).deepEqual(OFF);
      should(recorded).deepEqual([]);
    }
  });

  it('says which devices it widened but could not record, and records nothing for a device that vanished', async () => {
    const failing = rig({ recordFails: true });
    should(await repairSharingFromPairing(failing.deps)).deepEqual({
      kind: 'repaired',
      deviceIds: [],
      unrecorded: [PHONE],
      failed: [],
    });

    const { deps, recorded } = rig();
    const gone = { ...deps, devices: { ...deps.devices, setDeviceGrants: async () => false } };
    should(await repairSharingFromPairing(gone)).deepEqual({
      kind: 'repaired',
      deviceIds: [],
      unrecorded: [],
      failed: [],
    });
    should(recorded).deepEqual([]);
  });

  it('reports a device whose write threw, and still repairs the others', async () => {
    const { deps, stored } = rig({ devices: { [PHONE]: oldFull(), [LAPTOP]: oldFull() } });
    const flaky = {
      ...deps,
      devices: {
        ...deps.devices,
        setDeviceGrants: async (id: string, grants: CapabilityGrants) => {
          if (id === PHONE) throw new Error('disk full');
          return await deps.devices.setDeviceGrants(id, grants);
        },
      },
    };

    should(await repairSharingFromPairing(flaky)).deepEqual({
      kind: 'repaired',
      deviceIds: [LAPTOP],
      unrecorded: [],
      failed: [PHONE],
    });
    should(stored.get(PHONE)?.sharing).deepEqual(OFF);
    should(stored.get(LAPTOP)?.sharing).deepEqual(ON);
  });
});
