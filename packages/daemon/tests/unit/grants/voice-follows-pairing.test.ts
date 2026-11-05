import { describe, it } from 'bun:test';
import {
  type CapabilityGrants,
  DAEMON_CAPABILITIES,
  type DaemonCapability,
  FULL_DEVICE_GRANTS,
  LIMITED_DEVICE_GRANTS,
} from '@ferretry/protocol';
import should from 'should';
import {
  CAPABILITIES_BEFORE_SHARING,
  CAPABILITIES_BEFORE_VOICE,
  DEFAULT_CAPABILITY_GRANTS,
  type EnforcedGrants,
  type GrantAuditEntry,
  repairSharingFromPairing,
  repairVoiceFromPairing,
  SHARING_REPAIR_ACTOR,
  VOICE_RELEASED_AT,
  VOICE_REPAIR_ACTOR,
  VOICE_REPAIR_JOURNAL_MAX_BYTES,
  type WholeJournal,
} from '../../../src/lib/index.ts';

const PHONE = 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa';
const TABLET = 'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb';
const LAPTOP = 'fy_device_id_cccccccccccccccccccccc';
const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const BEFORE = '2026-10-20T00:00:00.000Z';
const AFTER = '2026-11-05T12:00:00.000Z';
const OFF = { use: false, configure: false };
const ON = { use: true, configure: true };

/** A device from after Sharing and before Voice: the eight capabilities on, Voice filled off by the upgrade. */
const preVoiceFull = (): CapabilityGrants => ({ ...FULL_DEVICE_GRANTS, voice: OFF });

/** A device from before Sharing: the seven capabilities on, Sharing AND Voice filled off by the upgrade. */
const preSharingFull = (): CapabilityGrants => ({ ...FULL_DEVICE_GRANTS, sharing: OFF, voice: OFF });

interface Rig {
  devices?: Record<string, CapabilityGrants>;
  journal?: WholeJournal;
  /** `'unknown'` stands for an unreadable daemon-wide answer; a plain `undefined` would read as the default. */
  daemonWide?: EnforcedGrants | 'unknown';
  recordFails?: boolean;
}

/**
 * A world with ONE store and ONE journal, so the Sharing repair's own record is visible to the Voice repair that
 * runs after it in the same boot — which is the ordering the real boot has.
 */
function rig({
  devices = { [PHONE]: preVoiceFull() },
  journal = { kind: 'read', entries: [], unreadable: 0 },
  daemonWide = DEFAULT_CAPABILITY_GRANTS,
  recordFails = false,
}: Rig = {}) {
  const stored = new Map(Object.entries(devices));
  const entries: GrantAuditEntry[] = journal.kind === 'read' ? [...journal.entries] : [];
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
      readAll: async (maxBytes: number): Promise<WholeJournal> => {
        reads += 1;
        should(maxBytes).equal(VOICE_REPAIR_JOURNAL_MAX_BYTES);
        return journal.kind === 'read' ? { ...journal, entries: [...entries] } : journal;
      },
    },
    audit: {
      record: async (entry: GrantAuditEntry) => {
        if (recordFails) throw new Error('disk full');
        entries.push(entry);
      },
      recent: async () => ({ entries: [], unreadable: 0, truncated: false }),
    },
    clock: { nowMs: () => NOW },
  };
  /** Exactly what `start` does: Sharing first, then Voice. */
  const boot = async () => {
    const sharing = await repairSharingFromPairing({
      ...deps,
      journal: { readAll: async () => deps.journal.readAll(VOICE_REPAIR_JOURNAL_MAX_BYTES) },
    });
    return { sharing, voice: await repairVoiceFromPairing(deps) };
  };
  return { deps, stored, entries, boot, reads: () => reads };
}

const journalOf = (...entries: GrantAuditEntry[]): WholeJournal => ({ kind: 'read', entries, unreadable: 0 });
const none = { kind: 'repaired', deviceIds: [], unrecorded: [], failed: [] } as const;

describe('Voice for a device that held every other capability before Voice existed', () => {
  it('turns Voice on for a pre-Voice full device, and records it under its own actor after the write', async () => {
    const { deps, stored, entries } = rig();

    const outcome = await repairVoiceFromPairing(deps);

    should(outcome).deepEqual({ kind: 'repaired', deviceIds: [PHONE], unrecorded: [], failed: [] });
    should(stored.get(PHONE)?.voice).deepEqual(ON);
    should(entries).deepEqual([
      {
        actor: VOICE_REPAIR_ACTOR,
        changes: [`${PHONE}/voice.use=on`, `${PHONE}/voice.configure=on`],
        at: '2026-11-06T12:00:00.000Z',
      },
    ]);
    should(VOICE_REPAIR_ACTOR).equal('daemon:voice-follows-pairing');
  });

  it('changes nothing but Voice on the device it repairs', async () => {
    const { deps, stored } = rig();
    await repairVoiceFromPairing(deps);
    should(stored.get(PHONE)).deepEqual(FULL_DEVICE_GRANTS);
  });

  it('never widens a device that lacked any one of the eight capabilities before Voice, Sharing included', async () => {
    for (const lacking of CAPABILITIES_BEFORE_VOICE) {
      for (const partial of [OFF, { use: true, configure: false }, { use: false, configure: true }]) {
        const { deps, stored, reads } = rig({ devices: { [PHONE]: { ...preVoiceFull(), [lacking]: partial } } });

        should(await repairVoiceFromPairing(deps)).deepEqual(none);
        should(stored.get(PHONE)?.voice).deepEqual(OFF);
        // No candidate, so neither the daemon-wide answer nor the journal is read: an ordinary boot costs nothing.
        should(reads()).equal(0);
      }
    }
  });

  it('never widens a hand-restricted device, however it was restricted', async () => {
    const { deps, stored } = rig({
      devices: {
        [PHONE]: { ...preVoiceFull(), terminal: { use: true, configure: false } },
        [TABLET]: { ...LIMITED_DEVICE_GRANTS, voice: OFF },
        [LAPTOP]: { ...preVoiceFull(), sharing: OFF },
      },
    });

    should(await repairVoiceFromPairing(deps)).deepEqual(none);
    for (const id of [PHONE, TABLET, LAPTOP]) should(stored.get(id)?.voice).deepEqual(OFF);
  });

  it('never widens a device that already holds any of Voice', async () => {
    for (const held of [{ use: true, configure: false }, { use: false, configure: true }, ON]) {
      const { deps, stored, reads } = rig({ devices: { [PHONE]: { ...preVoiceFull(), voice: held } } });

      should(await repairVoiceFromPairing(deps)).deepEqual(none);
      should(stored.get(PHONE)?.voice).deepEqual(held);
      should(reads()).equal(0);
    }
  });

  it('repairs nothing when the daemon-wide Pairing is not fully on, and says so when the daemon-wide answer is unknown', async () => {
    for (const pairing of [{ use: true, configure: false }, { use: false, configure: true }, OFF]) {
      const off = rig({ daemonWide: { ...DEFAULT_CAPABILITY_GRANTS, pairing } });
      should(await repairVoiceFromPairing(off.deps)).deepEqual(none);
      should(off.stored.get(PHONE)?.voice).deepEqual(OFF);
    }

    const unknown = rig({ daemonWide: 'unknown' });
    should(await repairVoiceFromPairing(unknown.deps)).deepEqual({ kind: 'skipped', reason: 'grants-undetermined' });
    should(unknown.stored.get(PHONE)?.voice).deepEqual(OFF);
  });

  it('never undoes a Voice set by hand, however long ago, nor touches a device changed since Voice existed', async () => {
    const journal = journalOf(
      { actor: 'admin-cli', changes: [`${PHONE}/voice.use=off`], at: BEFORE },
      // A device widened or narrowed by hand after Voice existed: whoever did it saw Voice and decided.
      { actor: 'device:x', changes: [`${TABLET}/terminal.use=on`], at: AFTER },
      // Before Voice existed, a change to another capability decides nothing about Voice.
      { actor: 'admin-cli', changes: [`${LAPTOP}/terminal.use=on`], at: BEFORE },
      // A daemon-wide change names no device.
      { actor: 'admin-ui', changes: ['voice.use=off'], at: AFTER },
    );
    const { deps, stored } = rig({
      devices: { [PHONE]: preVoiceFull(), [TABLET]: preVoiceFull(), [LAPTOP]: preVoiceFull() },
      journal,
    });

    should(await repairVoiceFromPairing(deps)).deepEqual({
      kind: 'repaired',
      deviceIds: [LAPTOP],
      unrecorded: [],
      failed: [],
    });
    should(stored.get(PHONE)?.voice).deepEqual(OFF);
    should(stored.get(TABLET)?.voice).deepEqual(OFF);
    should(stored.get(LAPTOP)?.voice).deepEqual(ON);
    should(VOICE_RELEASED_AT < AFTER && VOICE_RELEASED_AT > BEFORE).be.true();
  });

  it('repairs a device at most once, because its own record marks it', async () => {
    const first = rig();
    await repairVoiceFromPairing(first.deps);
    // The owner then turns the phone's Voice off by hand; the next boot reads the repair's record.
    const second = rig({ journal: journalOf(...first.entries) });

    should(await repairVoiceFromPairing(second.deps)).deepEqual(none);
    should(second.stored.get(PHONE)?.voice).deepEqual(OFF);
  });

  it('repairs nothing when the journal is too large to read whole, or holds a line it cannot read', async () => {
    for (const [journal, reason] of [
      [{ kind: 'too-large' }, 'journal-too-large'],
      [{ kind: 'read', entries: [], unreadable: 1 }, 'journal-unreadable'],
    ] as const) {
      const { deps, stored, entries } = rig({ journal });

      should(await repairVoiceFromPairing(deps)).deepEqual({ kind: 'skipped', reason });
      should(stored.get(PHONE)?.voice).deepEqual(OFF);
      should(entries).deepEqual([]);
    }
  });

  it('says which devices it widened but could not record, and records nothing for a device that vanished or whose write threw', async () => {
    const failing = rig({ recordFails: true });
    should(await repairVoiceFromPairing(failing.deps)).deepEqual({
      kind: 'repaired',
      deviceIds: [],
      unrecorded: [PHONE],
      failed: [],
    });

    const { deps, entries } = rig({ devices: { [PHONE]: preVoiceFull(), [LAPTOP]: preVoiceFull() } });
    const gone = { ...deps, devices: { ...deps.devices, setDeviceGrants: async () => false } };
    should(await repairVoiceFromPairing(gone)).deepEqual(none);
    should(entries).deepEqual([]);

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
    should(await repairVoiceFromPairing(flaky)).deepEqual({
      kind: 'repaired',
      deviceIds: [LAPTOP],
      unrecorded: [],
      failed: [PHONE],
    });
  });
});

describe('the Sharing repair runs before the Voice repair, in the same boot', () => {
  it('leaves a device from before Sharing with BOTH, and records each under its own actor', async () => {
    const { boot, stored, entries } = rig({ devices: { [PHONE]: preSharingFull() } });

    const { sharing, voice } = await boot();

    should(sharing).deepEqual({ kind: 'repaired', deviceIds: [PHONE], unrecorded: [], failed: [] });
    should(voice).deepEqual({ kind: 'repaired', deviceIds: [PHONE], unrecorded: [], failed: [] });
    should(stored.get(PHONE)).deepEqual(FULL_DEVICE_GRANTS);
    should(entries.map(entry => entry.actor)).deepEqual([SHARING_REPAIR_ACTOR, VOICE_REPAIR_ACTOR]);
  });

  it('does not count the Sharing repair’s own record as somebody having decided about the device', async () => {
    // The Sharing repair's record names the device at a time after Voice shipped. Were it counted, the Voice repair
    // that follows it would never fire for the very device that most needs both.
    const { boot, stored, entries } = rig({ devices: { [PHONE]: preSharingFull() } });
    await boot();
    should(entries[0]?.actor).equal(SHARING_REPAIR_ACTOR);
    should(Date.parse(entries[0]?.at ?? '') >= Date.parse(VOICE_RELEASED_AT)).be.true();
    should(stored.get(PHONE)?.voice).deepEqual(ON);
  });

  it('still honours a person’s record about the device that sits beside the Sharing repair’s', async () => {
    const decidedBy = journalOf({ actor: 'admin-cli', changes: [`${PHONE}/terminal.use=on`], at: AFTER });
    const { boot, stored } = rig({ devices: { [PHONE]: preSharingFull() }, journal: decidedBy });

    const { sharing, voice } = await boot();

    // Sharing's window opened long before AFTER, so a person's record since then withholds it; with Sharing still
    // off the device is no Voice candidate at all.
    should(sharing).deepEqual(none);
    should(voice).deepEqual(none);
    should(stored.get(PHONE)?.sharing).deepEqual(OFF);
    should(stored.get(PHONE)?.voice).deepEqual(OFF);
  });

  it('gives a device from after Sharing only Voice', async () => {
    const { boot, stored, entries } = rig({ devices: { [PHONE]: preVoiceFull() } });

    const { sharing, voice } = await boot();

    should(sharing).deepEqual(none);
    should(voice).deepEqual({ kind: 'repaired', deviceIds: [PHONE], unrecorded: [], failed: [] });
    should(stored.get(PHONE)).deepEqual(FULL_DEVICE_GRANTS);
    should(entries.map(entry => entry.actor)).deepEqual([VOICE_REPAIR_ACTOR]);
  });

  it('gives a device that was hand-restricted before Sharing neither', async () => {
    const restricted: CapabilityGrants = { ...preSharingFull(), browser: { use: true, configure: false } };
    const { boot, stored, entries } = rig({ devices: { [PHONE]: restricted } });

    const { sharing, voice } = await boot();

    should(sharing).deepEqual(none);
    should(voice).deepEqual(none);
    should(stored.get(PHONE)).deepEqual(restricted);
    should(entries).deepEqual([]);
  });

  it('is run in that order by the daemon’s start', async () => {
    const source = await Bun.file(new URL('../../../bin/fyd.ts', import.meta.url)).text();
    const sharing = source.indexOf('await pairing.repairSharing?.()');
    const voice = source.indexOf('await pairing.repairVoice?.()');
    should(sharing).be.above(-1);
    should(voice).be.above(sharing);
  });
});

describe('the sets the repairs pin', () => {
  it('names the seven capabilities before Sharing and the eight before Voice, in the order they were added', () => {
    should([...CAPABILITIES_BEFORE_SHARING]).deepEqual([
      'fleet',
      'terminal',
      'browser',
      'filesystem',
      'warden',
      'pairing',
      'secrets',
    ]);
    should([...CAPABILITIES_BEFORE_VOICE]).deepEqual([...CAPABILITIES_BEFORE_SHARING, 'sharing']);
  });

  it('are exactly the capabilities that precede each in DAEMON_CAPABILITIES, so a reordering is caught', () => {
    const before = (capability: DaemonCapability) =>
      DAEMON_CAPABILITIES.slice(0, DAEMON_CAPABILITIES.indexOf(capability));
    should([...CAPABILITIES_BEFORE_SHARING]).deepEqual([...before('sharing')]);
    should([...CAPABILITIES_BEFORE_VOICE]).deepEqual([...before('voice')]);
  });
});
