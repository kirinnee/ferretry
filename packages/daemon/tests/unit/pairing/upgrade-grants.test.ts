import { describe, it } from 'bun:test';
import { join } from 'node:path';
import { DAEMON_CAPABILITIES, type DaemonCapability, FULL_DEVICE_GRANTS } from '@ferretry/protocol';
import should from 'should';
import { NodePairingCryptography, StatePairingRepository } from '../../../src/adapters/pairing/index.ts';
import { CAPABILITY_FOLLOWS } from '../../../src/adapters/pairing/state-pairing-repository.ts';
import { createFoundationPaths, PairingDeviceRegistry, resolveStateHome } from '../../../src/lib/index.ts';

/**
 * A daemon that is upgraded must start on the `devices.json` the release before it wrote.
 *
 * The device document is closed over `DAEMON_CAPABILITIES`, so adding a capability makes every stored record
 * one key short. Nothing here names a capability: the fixture is the real v4.172.x bytes (seven capabilities,
 * before `sharing`), and the generic test strips each capability this build knows from a full record in turn.
 * A capability added with no thought for old records fails here, on the day it is added.
 */
const FIXTURE = join(import.meta.dir, '../../fixtures/pairing/devices-v4.172.json');
const OLD_RELEASE_CAPABILITIES: readonly DaemonCapability[] = [
  'fleet',
  'terminal',
  'browser',
  'filesystem',
  'warden',
  'pairing',
  'secrets',
];
const PHONE = 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa';
const TABLET = 'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb';
const OFF = { use: false, configure: false };

/** What a record that lacks `capability` reads it as: the grant of the capability it follows, when stored, or off. */
const predated = (capability: DaemonCapability, stored: Record<string, unknown>): unknown => {
  const leader = CAPABILITY_FOLLOWS[capability];
  return leader !== undefined && stored[leader] !== undefined ? stored[leader] : OFF;
};

/** A state home held in memory: a file port with exactly the two calls the repository makes. */
function home() {
  const store = new Map<string, string>();
  const paths = createFoundationPaths(resolveStateHome({ fyHome: '/fy', homeDirectory: '/home' }));
  const files = {
    readText: async (path: string) => store.get(path),
    writeTextAtomic: async (path: string, text: string) => {
      store.set(path, text);
    },
  };
  return { store, paths, files, devicesPath: join(paths.state, 'devices.json') };
}

/** Stores an identity, then the document with `__DAEMON_ID__` read as that identity. */
async function seed(state: ReturnType<typeof home>, document: string) {
  const cryptography = new NodePairingCryptography();
  const identity = cryptography.newIdentity();
  state.store.set(
    state.paths.daemonIdentity,
    `${JSON.stringify({ schemaVersion: 1, privateKeyPem: identity.privateKeyPem })}\n`,
  );
  state.store.set(state.devicesPath, document.replaceAll('__DAEMON_ID__', identity.daemonId));
  return new StatePairingRepository(state.paths, state.files, cryptography);
}

const fixtureText = async (): Promise<string> => await Bun.file(FIXTURE).text();

describe('a daemon upgraded onto the devices.json of the release before it', () => {
  it('should hold the fixture to the capabilities that release knew, so it stays a record of the old bytes', async () => {
    // Arrange
    const document = JSON.parse(await fixtureText()) as { devices: { grants: Record<string, unknown> }[] };

    // Act + Assert
    for (const device of document.devices) should(Object.keys(device.grants)).deepEqual([...OLD_RELEASE_CAPABILITIES]);
  });

  it('should start on the fixture and read every device with the capabilities it predates off, or following the one they follow', async () => {
    // Arrange
    const state = home();
    const repository = await seed(state, await fixtureText());

    // Act
    const opened = await repository.open('workstation');
    const registry = new PairingDeviceRegistry(opened.daemonId, opened.devices);

    // Assert
    const newer = DAEMON_CAPABILITIES.filter(capability => !OLD_RELEASE_CAPABILITIES.includes(capability));
    should(newer.length).be.above(0);
    const stored = JSON.parse(await fixtureText()) as { devices: { id: string; grants: Record<string, unknown> }[] };
    for (const id of [PHONE, TABLET]) {
      const grants = registry.get(id)?.grants;
      const before = stored.devices.find(device => device.id === id)?.grants ?? {};
      should(Object.keys(grants ?? {}).sort()).deepEqual([...DAEMON_CAPABILITIES].sort());
      for (const capability of newer) should(grants?.[capability]).deepEqual(predated(capability, before));
    }
    // Sharing follows Pairing: the owner's phone (Pairing on) gets it, the limited tablet does not.
    should(registry.get(PHONE)?.grants.sharing).deepEqual({ use: true, configure: true });
    should(registry.get(TABLET)?.grants.sharing).deepEqual(OFF);
    should(registry.get(PHONE)?.grants.fleet).deepEqual({ use: true, configure: true });
    should(registry.get(TABLET)?.grants.terminal).deepEqual(OFF);
  });

  it('should keep exactly what the old record granted and widen nothing', async () => {
    // Arrange
    const state = home();
    const repository = await seed(state, await fixtureText());
    const before = JSON.parse(await fixtureText()) as { devices: { id: string; grants: Record<string, unknown> }[] };

    // Act
    const opened = await repository.open('workstation');

    // Assert
    for (const device of before.devices) {
      const read = opened.devices.find(candidate => candidate.id === device.id)?.grants;
      for (const capability of OLD_RELEASE_CAPABILITIES)
        should(read?.[capability]).deepEqual(device.grants[capability]);
    }
  });

  it('should write the document back whole, so a second open finds nothing to fill', async () => {
    // Arrange
    const state = home();
    const repository = await seed(state, await fixtureText());
    await repository.open('workstation');
    const written = state.store.get(state.devicesPath) ?? '';
    const stored = JSON.parse(written) as { devices: { grants: Record<string, unknown> }[] };
    let writes = 0;
    const counting = {
      ...state.files,
      writeTextAtomic: async (path: string, text: string) => {
        writes += 1;
        await state.files.writeTextAtomic(path, text);
      },
    };

    // Act
    await new StatePairingRepository(state.paths, counting).open('workstation');

    // Assert
    for (const device of stored.devices)
      should(Object.keys(device.grants).sort()).deepEqual([...DAEMON_CAPABILITIES].sort());
    should(writes).equal(0);
    should(state.store.get(state.devicesPath)).equal(written);
  });

  it('should open a record that lacks any one capability, whichever it is, as off or as the one it follows, the rest kept', async () => {
    for (const missing of DAEMON_CAPABILITIES) {
      // Arrange
      const state = home();
      const document = JSON.parse(await fixtureText()) as { devices: { grants: Record<string, unknown> }[] };
      const full = Object.fromEntries(
        DAEMON_CAPABILITIES.map(capability => [capability, { ...FULL_DEVICE_GRANTS[capability] }]),
      );
      const { [missing]: _removed, ...without } = full;
      for (const device of document.devices) device.grants = without;
      const repository = await seed(state, JSON.stringify(document));

      // Act
      const opened = await repository.open('workstation');

      // Assert
      for (const device of opened.devices) {
        for (const capability of DAEMON_CAPABILITIES) {
          should(device.grants[capability]).deepEqual(
            capability === missing ? predated(missing, without) : { use: true, configure: true },
          );
        }
      }
    }
  });

  it('should read a record with no capabilities at all as every capability off, a follower included', async () => {
    // Arrange
    const state = home();
    const document = JSON.parse(await fixtureText()) as { devices: { grants: Record<string, unknown> }[] };
    for (const device of document.devices) device.grants = {};
    const repository = await seed(state, JSON.stringify(document));

    // Act
    const opened = await repository.open('workstation');

    // Assert
    for (const device of opened.devices) {
      for (const capability of DAEMON_CAPABILITIES) should(device.grants[capability]).deepEqual(OFF);
    }
  });

  it('should never let a follower copy a malformed leader', async () => {
    // Arrange: Sharing is missing and Pairing is not a grant at all.
    const state = home();
    const document = JSON.parse(await fixtureText()) as { devices: { grants: Record<string, unknown> }[] };
    for (const device of document.devices) device.grants = { ...device.grants, pairing: { use: 'yes' } };
    const repository = await seed(state, JSON.stringify(document));

    // Act + Assert: the document is refused for Pairing; Sharing was never filled from it.
    await should(repository.open('workstation')).be.rejected();
  });

  it('should still refuse a record whose grants are wrong rather than guess, and a stored capability that is not one', async () => {
    // Arrange
    const document = JSON.parse(await fixtureText()) as { devices: { grants: Record<string, unknown> }[] };
    const malformed = structuredClone(document);
    const invented = structuredClone(document);
    for (const device of malformed.devices) device.grants = { ...device.grants, fleet: { use: 'yes' } };
    for (const device of invented.devices) device.grants = { ...device.grants, telepathy: OFF };

    // Act + Assert
    for (const bad of [malformed, invented]) {
      const state = home();
      const repository = await seed(state, JSON.stringify(bad));
      await should(repository.open('workstation')).be.rejected();
    }
  });
});
