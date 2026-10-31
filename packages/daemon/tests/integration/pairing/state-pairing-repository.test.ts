import { afterAll, describe, it } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DAEMON_CAPABILITIES,
  type DaemonId,
  LIMITED_DEVICE_GRANTS,
  FULL_DEVICE_GRANTS,
  PairingCodeSchema,
} from '@ferretry/protocol';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { NodePairingCryptography, StatePairingRepository } from '../../../src/adapters/pairing/index.ts';
import { createFoundationPaths, type PairingDeviceRecord, resolveStateHome } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

afterAll(async () => {
  await cleanupTempDirectories();
});

async function fixture(label: string) {
  const home = await tempDirectory(label);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  await files.ensureDirectory(paths.state, 0o700);
  return { home, paths, files, repository: new StatePairingRepository(paths, files) };
}

/** An Ed25519 SPKI: the fixed DER prefix and 32 key bytes. */
const DEVICE_KEY = Buffer.from([
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

/** A second Ed25519 SPKI, the key a device rotates to. */
const ROTATED_KEY = `${DEVICE_KEY.slice(0, -2)}Bg`;

function record(daemonId: DaemonId, id: string): PairingDeviceRecord {
  return {
    id,
    daemonId,
    name: 'Browser device',
    platform: 'browser',
    createdAt: '2026-08-03T12:00:00.000Z',
    lastSeenAt: '2026-08-03T12:00:00.000Z',
    publicKey: DEVICE_KEY,
    grants: LIMITED_DEVICE_GRANTS,
  };
}

describe('NodePairingCryptography', () => {
  it('should mint correctly sized, visibly typed handles from the injected random source', () => {
    let integer = 0;
    const cryptography = new NodePairingCryptography(
      size => Buffer.alloc(size, 7),
      maximum => {
        const value = integer % maximum;
        integer += 1;
        return value;
      },
    );

    should(cryptography.pairingCode()).equal('2345-6789');
    should(cryptography.pairingId()).equal(`fy_pair_${Buffer.alloc(16, 7).toString('base64url')}`);
    should(cryptography.deviceId()).equal(`fy_device_id_${Buffer.alloc(16, 7).toString('base64url')}`);
  });

  it('should generate only unambiguous codes accepted by the public schema', () => {
    let integer = 0;
    const cryptography = new NodePairingCryptography(
      size => Buffer.alloc(size),
      maximum => {
        const value = integer % maximum;
        integer += 1;
        return value;
      },
    );

    const codes = Array.from({ length: 4 }, () => cryptography.pairingCode());

    should(codes.every(code => PairingCodeSchema.safeParse(code).success)).be.true();
    should(codes.join('')).not.match(/[01ILOU]/u);
  });

  it('should persist an Ed25519 private key whose public fingerprint is the stable daemon id', () => {
    const cryptography = new NodePairingCryptography();

    const identity = cryptography.newIdentity();
    const restored = cryptography.identityFromPrivateKey(identity.privateKeyPem);

    should(identity.privateKeyPem).startWith('-----BEGIN PRIVATE KEY-----');
    should(identity.daemonId).match(/^fy_daemon_[A-Za-z0-9_-]{43}$/u);
    should(restored).deepEqual(identity);
    should(() => cryptography.identityFromPrivateKey('not a private key')).throw();
  });
});

describe('StatePairingRepository', () => {
  it('should create owner-only identity and empty device evidence on first boot', async () => {
    const { paths, repository } = await fixture('pairing-state-create');

    const state = await repository.open(' workstation ');

    should(state.daemonName).equal('workstation');
    should(state.daemonId).match(/^fy_daemon_[A-Za-z0-9_-]{43}$/u);
    should(state.devices).be.empty();
    should((await stat(join(paths.state, 'daemon-identity.json'))).mode & 0o777).equal(0o600);
    should((await stat(join(paths.state, 'devices.json'))).mode & 0o777).equal(0o600);
  });

  it('should turn a hostile or oversized host name into bounded display text', async () => {
    const hostile = await fixture('pairing-state-host-name');

    const state = await hostile.repository.open(`\u202E\u0000  ${'a'.repeat(120)}  `);

    should(state.daemonName).equal('a'.repeat(100));
  });

  it('should persist only hashed grants and restore the same daemon identity', async () => {
    const { paths, files, repository } = await fixture('pairing-state-restore');
    const before = await repository.open('workstation');
    await repository.add(record(before.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));

    const document = await files.readText(join(paths.state, 'devices.json'));
    const after = await new StatePairingRepository(paths, files).open('renamed workstation');

    should(document).not.containEql('fy_device_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    should(after.daemonId).equal(before.daemonId);
    should(after.daemonName).equal('renamed workstation');
    should(after.devices).have.length(1);
  });

  it('should keep the carrier a device paired over, and read a record that predates the field', async () => {
    const { paths, files, repository } = await fixture('pairing-state-carrier');
    const opened = await repository.open('workstation');
    await repository.add({ ...record(opened.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'), pairedOver: 'relay' });
    await repository.add(record(opened.daemonId, 'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb'));

    const after = await new StatePairingRepository(paths, files).open('workstation');

    should(after.devices.map(device => device.pairedOver)).deepEqual(['relay', undefined]);
  });

  it('should serialize concurrent grants so neither device is lost', async () => {
    const { paths, files, repository } = await fixture('pairing-state-concurrent');
    const state = await repository.open('workstation');

    await Promise.all([
      repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa')),
      repository.add(record(state.daemonId, 'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb')),
    ]);
    const reopened = await new StatePairingRepository(paths, files).open('workstation');

    should(reopened.devices.map(device => device.id)).deepEqual([
      'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa',
      'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb',
    ]);
  });

  it('should fail closed on incomplete, malformed, foreign, or duplicate durable state', async () => {
    const incomplete = await fixture('pairing-state-incomplete');
    await incomplete.files.writeTextAtomic(
      join(incomplete.paths.state, 'daemon-identity.json'),
      JSON.stringify({ schemaVersion: 1, privateKeyPem: 'not a key' }),
    );
    await should(incomplete.repository.open('workstation')).be.rejectedWith('pairing state is incomplete');

    const missingIdentity = await fixture('pairing-state-missing-identity');
    await missingIdentity.files.writeTextAtomic(
      join(missingIdentity.paths.state, 'devices.json'),
      JSON.stringify({ schemaVersion: 1, daemonId: `fy_daemon_${'z'.repeat(43)}`, devices: [] }),
    );
    await should(missingIdentity.repository.open('workstation')).be.rejectedWith('pairing state is incomplete');

    const malformed = await fixture('pairing-state-malformed');
    await malformed.files.writeTextAtomic(join(malformed.paths.state, 'daemon-identity.json'), '{');
    await malformed.files.writeTextAtomic(join(malformed.paths.state, 'devices.json'), '{}');
    await should(malformed.repository.open('workstation')).be.rejectedWith('pairing state is not valid JSON');

    const foreign = await fixture('pairing-state-foreign');
    const initial = await foreign.repository.open('workstation');
    await foreign.files.writeTextAtomic(
      join(foreign.paths.state, 'devices.json'),
      `${JSON.stringify({ schemaVersion: 1, daemonId: `fy_daemon_${'z'.repeat(43)}`, devices: [] })}\n`,
    );
    await should(new StatePairingRepository(foreign.paths, foreign.files).open('workstation')).be.rejectedWith(
      'device grants belong to a different daemon identity',
    );

    const duplicate = record(initial.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa');
    await foreign.files.writeTextAtomic(
      join(foreign.paths.state, 'devices.json'),
      `${JSON.stringify({ schemaVersion: 2, daemonId: initial.daemonId, devices: [duplicate, duplicate] })}\n`,
    );
    await should(new StatePairingRepository(foreign.paths, foreign.files).open('workstation')).be.rejectedWith(
      'device grants contain duplicate identities',
    );
  });

  it('should refuse writes before open, for another daemon, or for a duplicate identity', async () => {
    const { repository } = await fixture('pairing-state-refusals');
    const ownId = `fy_daemon_${'a'.repeat(43)}` as DaemonId;
    await should(repository.add(record(ownId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'))).be.rejectedWith(
      'pairing state is not open',
    );
    const state = await repository.open('workstation');
    await should(
      repository.add(record(`fy_daemon_${'z'.repeat(43)}` as DaemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa')),
    ).be.rejectedWith('a device grant belongs to a different daemon');
    await repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));
    await should(repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'))).be.rejectedWith(
      'a device identity already exists',
    );
  });

  it('should forget one grant durably and report an id it never held', async () => {
    // Arrange
    const { paths, files, repository } = await fixture('pairing-state-remove');
    const state = await repository.open('workstation');
    await repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));
    await repository.add(record(state.daemonId, 'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb'));

    // Act
    const removed = await repository.remove('fy_device_id_aaaaaaaaaaaaaaaaaaaaaa');
    const absent = await repository.remove('fy_device_id_cccccccccccccccccccccc');
    const reopened = await new StatePairingRepository(paths, files).open('workstation');

    // Assert — the document is what decides who comes back after a restart, so a revocation that only
    // dropped the live grant would hand the device its access back at the next boot.
    should(removed).be.true();
    should(absent).be.false();
    should((await repository.list()).map(device => device.id)).deepEqual(['fy_device_id_bbbbbbbbbbbbbbbbbbbbbb']);
    should(reopened.devices.map(device => device.id)).deepEqual(['fy_device_id_bbbbbbbbbbbbbbbbbbbbbb']);
  });

  it('should serialize a removal against a concurrent grant so neither write is lost', async () => {
    // Two snapshots taken at the same moment would each write a document missing the other's change,
    // and the loser here would be a device silently re-granted access.
    // Arrange
    const { paths, files, repository } = await fixture('pairing-state-remove-concurrent');
    const state = await repository.open('workstation');
    await repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));

    // Act
    await Promise.all([
      repository.add(record(state.daemonId, 'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb')),
      repository.remove('fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'),
    ]);
    const reopened = await new StatePairingRepository(paths, files).open('workstation');

    // Assert
    should(reopened.devices.map(device => device.id)).deepEqual(['fy_device_id_bbbbbbbbbbbbbbbbbbbbbb']);
  });

  it('should refuse to list or remove before the state home is open', async () => {
    const { repository } = await fixture('pairing-state-closed');

    await should(repository.list()).be.rejectedWith('pairing state is not open');
    await should(repository.remove('fy_device_id_aaaaaaaaaaaaaaaaaaaaaa')).be.rejectedWith('pairing state is not open');
  });
});

describe('StatePairingRepository device keys', () => {
  it('should persist only public keys, and drop every bearer grant a document from before device keys held', async () => {
    // Arrange — a v1 document whose grants each held the digest of a bearer token.
    const { paths, files, repository } = await fixture('pairing-state-bearer');
    const first = await repository.open('workstation');
    await files.writeTextAtomic(
      join(paths.state, 'devices.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        daemonId: first.daemonId,
        devices: [{ id: 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa', tokenHash: 'h'.repeat(43) }, { id: 'second' }],
      })}\n`,
    );

    // Act
    const reopened = await new StatePairingRepository(paths, files).open('workstation');
    const rewritten = JSON.parse((await files.readText(join(paths.state, 'devices.json'))) ?? '{}') as unknown;
    const again = await new StatePairingRepository(paths, files).open('workstation');

    // Assert — nothing in it can authenticate any more, so it lists nothing, and says how much it dropped once.
    should(reopened.devices).be.empty();
    should(reopened.droppedBearerGrants).equal(2);
    should(rewritten).deepEqual({ schemaVersion: 2, daemonId: first.daemonId, devices: [] });
    should(again.droppedBearerGrants).equal(0);
  });

  it('should refuse a grant whose key is not an Ed25519 public key, rather than store a device that can never get in', async () => {
    const { repository } = await fixture('pairing-state-bad-key');
    const state = await repository.open('workstation');
    await should(
      repository.add({ ...record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'), publicKey: 'not-a-key' }),
    ).be.rejected();
    should(await repository.list()).be.empty();
  });

  it('should record when a device was last seen, durably, and write nothing for one it does not hold', async () => {
    const { paths, files, repository } = await fixture('pairing-state-touch');
    const state = await repository.open('workstation');
    await repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));
    const before = await files.readText(join(paths.state, 'devices.json'));

    await repository.touch('fy_device_id_cccccccccccccccccccccc', '2026-08-04T12:00:00.000Z');
    should(await files.readText(join(paths.state, 'devices.json'))).equal(before);

    await repository.touch('fy_device_id_aaaaaaaaaaaaaaaaaaaaaa', '2026-08-04T12:00:00.000Z');
    const reopened = await new StatePairingRepository(paths, files).open('workstation');
    should(reopened.devices[0]?.lastSeenAt).equal('2026-08-04T12:00:00.000Z');
    should(reopened.devices[0]?.publicKey).equal(DEVICE_KEY);
  });

  it('should change one device’s grants durably, and write nothing for a device it does not hold', async () => {
    // Arrange
    const { paths, files, repository } = await fixture('pairing-state-grants');
    const state = await repository.open('workstation');
    await repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));
    const before = await files.readText(join(paths.state, 'devices.json'));

    // Act
    const missing = await repository.setGrants('fy_device_id_cccccccccccccccccccccc', FULL_DEVICE_GRANTS);
    const unchanged = await files.readText(join(paths.state, 'devices.json'));
    const changed = await repository.setGrants('fy_device_id_aaaaaaaaaaaaaaaaaaaaaa', FULL_DEVICE_GRANTS);
    const reopened = await new StatePairingRepository(paths, files).open('workstation');

    // Assert
    should([missing, changed]).deepEqual([false, true]);
    should(unchanged).equal(before);
    should(reopened.devices[0]?.grants).deepEqual(FULL_DEVICE_GRANTS);
  });

  it('should replace one device’s key durably with when it happened, and write nothing for a device it does not hold', async () => {
    // Arrange
    const { paths, files, repository } = await fixture('pairing-state-rotate');
    const state = await repository.open('workstation');
    await repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));
    const before = await files.readText(join(paths.state, 'devices.json'));

    // Act
    const missing = await repository.rotateKey(
      'fy_device_id_cccccccccccccccccccccc',
      ROTATED_KEY,
      '2026-08-05T12:00:00.000Z',
    );
    const unchanged = await files.readText(join(paths.state, 'devices.json'));
    const rotated = await repository.rotateKey(
      'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa',
      ROTATED_KEY,
      '2026-08-05T12:00:00.000Z',
    );
    const reopened = await new StatePairingRepository(paths, files).open('workstation');

    // Assert
    should([missing, rotated]).deepEqual([false, true]);
    should(unchanged).equal(before);
    should(reopened.devices[0]?.publicKey).equal(ROTATED_KEY);
    should(reopened.devices[0]?.keyRotatedAt).equal('2026-08-05T12:00:00.000Z');
  });

  it('should read a schema-2 device written before per-device grants as LIMITED, a narrowing', async () => {
    // A missing `grants` is safe to read as fleet.use only, which is why the document stays at schema 2.
    // Arrange
    const { paths, files, repository } = await fixture('pairing-state-legacy-grants');
    const state = await repository.open('workstation');
    const { grants: _dropped, ...legacy } = record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa');
    await files.writeTextAtomic(
      join(paths.state, 'devices.json'),
      `${JSON.stringify({ schemaVersion: 2, daemonId: state.daemonId, devices: [legacy] })}\n`,
    );

    // Act
    const reopened = await new StatePairingRepository(paths, files).open('workstation');

    // Assert
    should(reopened.devices[0]?.grants).deepEqual(LIMITED_DEVICE_GRANTS);
  });

  it('should start on the devices.json of the release before the newest capability, on the real disk', async () => {
    // The unit tier proves the rule; this proves it through the real file system and a real identity.
    // Arrange
    const { paths, files, repository } = await fixture('pairing-state-upgrade');
    const state = await repository.open('workstation');
    const old = (
      await readFile(join(import.meta.dir, '../../fixtures/pairing/devices-v4.172.json'), 'utf8')
    ).replaceAll('__DAEMON_ID__', state.daemonId);
    await files.writeTextAtomic(join(paths.state, 'devices.json'), old);

    // Act
    const reopened = await new StatePairingRepository(paths, files).open('workstation');
    const rewritten = JSON.parse(await readFile(join(paths.state, 'devices.json'), 'utf8')) as {
      devices: { grants: Record<string, unknown> }[];
    };

    // Assert
    should(reopened.devices.length).equal(2);
    for (const device of reopened.devices) should(device.grants.sharing).deepEqual({ use: false, configure: false });
    for (const device of rewritten.devices)
      should(Object.keys(device.grants).sort()).deepEqual([...DAEMON_CAPABILITIES].sort());
  });

  it('should refuse a device grant document whose grants are malformed, rather than guess', async () => {
    // Arrange
    const { paths, files, repository } = await fixture('pairing-state-bad-grants');
    const state = await repository.open('workstation');
    const bad = { ...record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'), grants: { fleet: { use: 'yes' } } };
    await files.writeTextAtomic(
      join(paths.state, 'devices.json'),
      `${JSON.stringify({ schemaVersion: 2, daemonId: state.daemonId, devices: [bad] })}\n`,
    );

    // Act + Assert
    await should(new StatePairingRepository(paths, files).open('workstation')).be.rejected();
  });
});
