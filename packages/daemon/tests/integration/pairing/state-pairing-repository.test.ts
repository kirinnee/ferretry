import { afterAll, describe, it } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type DaemonId, PairingCodeSchema } from '@ferretry/protocol';
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

function record(daemonId: DaemonId, id: string): PairingDeviceRecord {
  return {
    id,
    daemonId,
    name: 'Browser device',
    platform: 'browser',
    createdAt: '2026-08-03T12:00:00.000Z',
    lastSeenAt: '2026-08-03T12:00:00.000Z',
    tokenHash: 'h'.repeat(43),
  };
}

describe('NodePairingCryptography', () => {
  it('should mint correctly sized, visibly typed secrets from the injected random source', () => {
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
    const token = cryptography.deviceToken();
    should(token).equal(`fy_device_${Buffer.alloc(32, 7).toString('base64url')}`);
    should(Buffer.from(token.slice('fy_device_'.length), 'base64url').byteLength).equal(32);
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

  it('should domain-separate a token hash by daemon', () => {
    const cryptography = new NodePairingCryptography();
    const token = `fy_device_${'a'.repeat(43)}`;

    const first = cryptography.hashDeviceToken(`fy_daemon_${'b'.repeat(43)}`, token);
    const second = cryptography.hashDeviceToken(`fy_daemon_${'c'.repeat(43)}`, token);

    should(first).match(/^[A-Za-z0-9_-]{43}$/u);
    should(second).not.equal(first);
    should(first).not.containEql(token);
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
      `${JSON.stringify({ schemaVersion: 1, daemonId: initial.daemonId, devices: [duplicate, duplicate] })}\n`,
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
