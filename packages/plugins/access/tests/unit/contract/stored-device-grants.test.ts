import { describe, it } from 'bun:test';
import { CAPABILITY_NAMES, type CapabilityName } from '@ferretry/core-gate/contract';
import should from 'should';
import { DevicesFileSchema } from '../../../contract/state.ts';

/**
 * A stored device record must survive a NEW capability: a capability the file predates reads as OFF (a narrowing),
 * never as damage. `docs/grants.md` ("Adding a capability") makes a new snapshot entry part of adding one.
 */

const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}`;
const KEY = Buffer.from([
  0x30,
  0x2a,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x03,
  0x21,
  0x00,
  ...new Array(32).fill(5),
]).toString('base64url');

/**
 * Every capability set a release has written to `devices.json`, oldest first. APPEND the new set when a capability is
 * added; never edit an earlier entry — those are the files already on people's machines.
 */
const RELEASED_CAPABILITY_SETS: readonly (readonly string[])[] = [
  ['fleet', 'terminal', 'browser', 'filesystem', 'warden', 'pairing'],
  ['fleet', 'terminal', 'browser', 'filesystem', 'warden', 'pairing', 'secrets'],
  ['fleet', 'terminal', 'browser', 'filesystem', 'warden', 'pairing', 'secrets', 'sharing'],
  ['fleet', 'terminal', 'browser', 'filesystem', 'warden', 'pairing', 'secrets', 'sharing', 'voice'],
];

const file = (capabilities: readonly string[], on: (name: string) => boolean = () => true) => ({
  format: 1,
  daemonId: DAEMON_ID,
  devices: ['a', 'b'].map(letter => ({
    id: `fy_device_id_${letter.repeat(22)}`,
    daemonId: DAEMON_ID,
    name: `Synthetic ${letter}`,
    platform: 'browser',
    createdAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-01T00:00:00.000Z',
    pairedOver: 'relay',
    publicKey: KEY,
    grants: Object.fromEntries(capabilities.map(name => [name, { use: on(name), configure: on(name) }])),
  })),
});

describe('a stored device record written before a capability existed', () => {
  it('should read the missing capability as off and keep every other grant', () => {
    const parsed = DevicesFileSchema.parse(
      file(['fleet', 'terminal', 'browser', 'filesystem', 'warden', 'pairing', 'secrets', 'sharing']),
    );

    should(parsed.devices).have.length(2);
    for (const device of parsed.devices) {
      should(device.grants.voice).eql({ use: false, configure: false });
      should(device.grants.fleet).eql({ use: true, configure: true });
      should(device.grants.sharing).eql({ use: true, configure: true });
    }
  });

  for (const [index, released] of RELEASED_CAPABILITY_SETS.entries()) {
    it(`should read a record written with release set #${String(index + 1)} (${String(released.length)} capabilities)`, () => {
      const parsed = DevicesFileSchema.parse(file(released, name => name === 'fleet'));

      for (const device of parsed.devices)
        for (const name of CAPABILITY_NAMES) {
          const expected = released.includes(name) && name === 'fleet';
          should(device.grants[name]).eql({ use: expected, configure: expected });
        }
    });
  }

  it('should record the CURRENT capability list as the newest released set', () => {
    should([...(RELEASED_CAPABILITY_SETS.at(-1) ?? [])]).eql([...CAPABILITY_NAMES]);
  });

  it('should survive any one capability being absent from the file', () => {
    for (const absent of CAPABILITY_NAMES) {
      const present = CAPABILITY_NAMES.filter((name: CapabilityName) => name !== absent);
      const parsed = DevicesFileSchema.parse(file(present));
      for (const device of parsed.devices) should(device.grants[absent]).eql({ use: false, configure: false });
    }
  });

  it('should still refuse a capability this build does not know, a half-written grant and a non-object', () => {
    const base = file(CAPABILITY_NAMES);
    const withGrants = (grants: unknown) => ({ ...base, devices: [{ ...base.devices[0], grants }, base.devices[1]] });

    should(
      DevicesFileSchema.safeParse(withGrants({ ...base.devices[0]?.grants, someday: { use: true, configure: true } }))
        .success,
    ).be.false();
    should(
      DevicesFileSchema.safeParse(withGrants({ ...base.devices[0]?.grants, fleet: { use: true } })).success,
    ).be.false();
    should(DevicesFileSchema.safeParse(withGrants('open')).success).be.false();
    should(DevicesFileSchema.safeParse(withGrants(null)).success).be.false();
    should(DevicesFileSchema.safeParse(withGrants([])).success).be.false();
  });
});
