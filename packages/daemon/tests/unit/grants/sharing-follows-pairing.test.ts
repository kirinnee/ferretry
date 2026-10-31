import { describe, it } from 'bun:test';
import { type CapabilityGrants, FULL_DEVICE_GRANTS, LIMITED_DEVICE_GRANTS } from '@ferretry/protocol';
import should from 'should';
import {
  type GrantAuditEntry,
  repairSharingFromPairing,
  SHARING_REPAIR_ACTOR,
  SHARING_REPAIR_JOURNAL_MAX_BYTES,
  type WholeJournal,
} from '../../../src/lib/index.ts';

const PHONE = 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa';
const TABLET = 'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb';
const LAPTOP = 'fy_device_id_cccccccccccccccccccccc';
const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const OFF = { use: false, configure: false };
const ON = { use: true, configure: true };

/** The owner's phone as the upgrade left it: everything on, Sharing filled off. */
const upgradedFull = (): CapabilityGrants => ({ ...FULL_DEVICE_GRANTS, sharing: OFF });

function rig(
  devices: Record<string, CapabilityGrants>,
  journal: WholeJournal = { kind: 'read', entries: [], unreadable: 0 },
) {
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
    journal: {
      readAll: async (maxBytes: number) => {
        reads += 1;
        should(maxBytes).equal(SHARING_REPAIR_JOURNAL_MAX_BYTES);
        return journal;
      },
    },
    audit: {
      record: async (entry: GrantAuditEntry) => {
        recorded.push(entry);
      },
      recent: async () => ({ entries: [], unreadable: 0, truncated: false }),
    },
    clock: { nowMs: () => NOW },
  };
  return { deps, stored, recorded, reads: () => reads };
}

describe('Sharing follows Pairing for a device paired before Sharing existed', () => {
  it('turns Sharing on for a device that holds Pairing, and records the change under its own actor', async () => {
    const { deps, stored, recorded } = rig({ [PHONE]: upgradedFull() });

    const outcome = await repairSharingFromPairing(deps);

    should(outcome).deepEqual({ kind: 'repaired', deviceIds: [PHONE] });
    should(stored.get(PHONE)?.sharing).deepEqual(ON);
    should(stored.get(PHONE)?.fleet).deepEqual(ON);
    should(recorded).deepEqual([
      {
        actor: SHARING_REPAIR_ACTOR,
        changes: [`${PHONE}/sharing.use=on`, `${PHONE}/sharing.configure=on`],
        at: '2026-10-31T12:00:00.000Z',
      },
    ]);
  });

  it('never touches a device without Pairing on both axes, or one already holding any Sharing', async () => {
    const { deps, stored, recorded, reads } = rig({
      [TABLET]: { ...LIMITED_DEVICE_GRANTS, sharing: OFF },
      [LAPTOP]: { ...upgradedFull(), pairing: { use: true, configure: false } },
      [PHONE]: { ...upgradedFull(), sharing: { use: true, configure: false } },
    });

    const outcome = await repairSharingFromPairing(deps);

    should(outcome).deepEqual({ kind: 'repaired', deviceIds: [] });
    should(stored.get(TABLET)?.sharing).deepEqual(OFF);
    should(stored.get(LAPTOP)?.sharing).deepEqual(OFF);
    should(stored.get(PHONE)?.sharing).deepEqual({ use: true, configure: false });
    should(recorded).deepEqual([]);
    // No candidate, so the journal is never read: an ordinary boot costs nothing.
    should(reads()).equal(0);
  });

  it('never undoes a Sharing somebody set by hand, however long ago', async () => {
    const journal: WholeJournal = {
      kind: 'read',
      unreadable: 0,
      entries: [
        { actor: 'admin-cli', changes: [`${PHONE}/sharing.use=off`], at: '2026-10-01T00:00:00.000Z' },
        { actor: 'admin-cli', changes: [`${LAPTOP}/terminal.use=off`], at: '2026-10-02T00:00:00.000Z' },
        { actor: 'admin-ui', changes: ['sharing.use=off'], at: '2026-10-03T00:00:00.000Z' },
      ],
    };
    const { deps, stored } = rig({ [PHONE]: upgradedFull(), [LAPTOP]: upgradedFull() }, journal);

    const outcome = await repairSharingFromPairing(deps);

    // The phone's own Sharing was set by hand; the laptop's record names another capability; a daemon-wide
    // change names no device and decides nothing here.
    should(outcome).deepEqual({ kind: 'repaired', deviceIds: [LAPTOP] });
    should(stored.get(PHONE)?.sharing).deepEqual(OFF);
    should(stored.get(LAPTOP)?.sharing).deepEqual(ON);
  });

  it('repairs a device at most once, because its own record marks it', async () => {
    const first = rig({ [PHONE]: upgradedFull() });
    await repairSharingFromPairing(first.deps);
    // The owner then turns the phone's Sharing off by hand; the next boot reads both records.
    first.stored.set(PHONE, upgradedFull());
    const second = rig({ [PHONE]: upgradedFull() }, { kind: 'read', entries: first.recorded, unreadable: 0 });

    const outcome = await repairSharingFromPairing(second.deps);

    should(outcome).deepEqual({ kind: 'repaired', deviceIds: [] });
    should(second.stored.get(PHONE)?.sharing).deepEqual(OFF);
  });

  it('repairs nothing when the journal is too large to read whole, or holds a line it cannot read', async () => {
    for (const [journal, reason] of [
      [{ kind: 'too-large' }, 'journal-too-large'],
      [{ kind: 'read', entries: [], unreadable: 1 }, 'journal-unreadable'],
    ] as const) {
      const { deps, stored, recorded } = rig({ [PHONE]: upgradedFull() }, journal);

      const outcome = await repairSharingFromPairing(deps);

      should(outcome).deepEqual({ kind: 'skipped', reason });
      should(stored.get(PHONE)?.sharing).deepEqual(OFF);
      should(recorded).deepEqual([]);
    }
  });

  it('records nothing for a device that disappeared before its write', async () => {
    const { deps, recorded } = rig({ [PHONE]: upgradedFull() });
    const gone = { ...deps, devices: { ...deps.devices, setDeviceGrants: async () => false } };

    const outcome = await repairSharingFromPairing(gone);

    should(outcome).deepEqual({ kind: 'repaired', deviceIds: [] });
    should(recorded).deepEqual([]);
  });
});
