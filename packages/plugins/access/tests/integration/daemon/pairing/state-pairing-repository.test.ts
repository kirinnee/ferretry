import { describe, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { NodePairingCryptography, StatePairingRepository } from '../../../../daemon/adapters/pairing/index.ts';
import type { PairingDeviceRecord } from '../../../../daemon/lib/pairing/index.ts';
import {
  type DaemonId,
  DevicesFile,
  FULL_DEVICE_GRANTS,
  LIMITED_DEVICE_GRANTS,
  PairingCodeSchema,
} from '../../../../daemon/lib/wire.ts';

const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}` as DaemonId;
const FOREIGN_DAEMON_ID = `fy_daemon_${'z'.repeat(43)}` as DaemonId;

/**
 * Access's `state/access/` in memory, with the kernel store's rules (format first, schema checked, damage reported).
 * The daemon identity is the kernel's: a case hands it in, as the runtime does.
 */
function fixture() {
  const folder = new MemoryStateFolder();
  const port = folder.port([DevicesFile]);
  return {
    folder,
    repository: new StatePairingRepository(port),
    reopen: () => new StatePairingRepository(folder.port([DevicesFile])),
    document: () => folder.raw(DevicesFile),
  };
}

const identity = (daemonName = 'workstation') => ({ daemonId: DAEMON_ID, daemonName });

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
});

describe('StatePairingRepository', () => {
  it('P65 an unpaired machine opens owner-only, empty device evidence on first boot with no setup', async () => {
    const { repository, document } = fixture();

    const state = await repository.open(identity(' workstation '));

    should(state.daemonName).equal('workstation');
    should(state.daemonId).equal(DAEMON_ID);
    should(state.devices).be.empty();
    should(DevicesFile.mode).equal(0o600);
    should(JSON.parse(document() ?? '{}')).deepEqual({ format: 1, daemonId: DAEMON_ID, devices: [] });
  });

  it('should turn a hostile or oversized host name into bounded display text', async () => {
    const { repository } = fixture();

    const state = await repository.open(identity(`‮\u0000  ${'a'.repeat(120)}  `));

    should(state.daemonName).equal('a'.repeat(100));
  });

  it('P10 should persist the device key as SPKI under the same daemon identity, and nothing that authenticates', async () => {
    const { repository, document, reopen } = fixture();
    const before = await repository.open(identity());
    await repository.add(record(before.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));

    const written = document() ?? '';
    const after = await reopen().open(identity('renamed workstation'));

    should(JSON.parse(written).devices[0].publicKey).equal(DEVICE_KEY);
    should(written).not.match(/token|hash|privateKey/iu);
    should(after.daemonId).equal(before.daemonId);
    should(after.daemonName).equal('renamed workstation');
    should(after.devices).have.length(1);
  });

  it('should keep the carrier a device paired over, and read a record that does not name one', async () => {
    const { repository, reopen } = fixture();
    const opened = await repository.open(identity());
    await repository.add({ ...record(opened.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'), pairedOver: 'relay' });
    await repository.add(record(opened.daemonId, 'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb'));

    const after = await reopen().open(identity());

    should(after.devices.map(device => device.pairedOver)).deepEqual(['relay', undefined]);
  });

  it('should serialize concurrent grants so neither device is lost', async () => {
    const { repository, reopen } = fixture();
    const state = await repository.open(identity());

    await Promise.all([
      repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa')),
      repository.add(record(state.daemonId, 'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb')),
    ]);
    const reopened = await reopen().open(identity());

    should(reopened.devices.map(device => device.id)).deepEqual([
      'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa',
      'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb',
    ]);
  });

  it('should fail closed on malformed, foreign, or duplicate durable state', async () => {
    const malformed = fixture();
    malformed.folder.plant(DevicesFile, '{');
    await should(malformed.repository.open(identity())).be.rejectedWith(/device grants are damaged/u);

    const foreign = fixture();
    foreign.folder.plant(DevicesFile, JSON.stringify({ format: 1, daemonId: FOREIGN_DAEMON_ID, devices: [] }));
    await should(foreign.repository.open(identity())).be.rejectedWith(
      'device grants belong to a different daemon identity',
    );

    const duplicated = fixture();
    const duplicate = record(DAEMON_ID, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa');
    duplicated.folder.plant(
      DevicesFile,
      JSON.stringify({ format: 1, daemonId: DAEMON_ID, devices: [duplicate, duplicate] }),
    );
    await should(duplicated.repository.open(identity())).be.rejectedWith('device grants contain duplicate identities');
  });

  it('should refuse writes before open, for another daemon, or for a duplicate identity', async () => {
    const { repository } = fixture();
    await should(repository.add(record(DAEMON_ID, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'))).be.rejectedWith(
      'pairing state is not open',
    );
    const state = await repository.open(identity());
    await should(repository.add(record(FOREIGN_DAEMON_ID, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'))).be.rejectedWith(
      'a device grant belongs to a different daemon',
    );
    await repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));
    await should(repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'))).be.rejectedWith(
      'a device identity already exists',
    );
  });

  it('should forget one grant durably and report an id it never held', async () => {
    // Arrange
    const { repository, reopen } = fixture();
    const state = await repository.open(identity());
    await repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));
    await repository.add(record(state.daemonId, 'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb'));

    // Act
    const removed = await repository.remove('fy_device_id_aaaaaaaaaaaaaaaaaaaaaa');
    const absent = await repository.remove('fy_device_id_cccccccccccccccccccccc');
    const reopened = await reopen().open(identity());

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
    const { repository, reopen } = fixture();
    const state = await repository.open(identity());
    await repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));

    // Act
    await Promise.all([
      repository.add(record(state.daemonId, 'fy_device_id_bbbbbbbbbbbbbbbbbbbbbb')),
      repository.remove('fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'),
    ]);
    const reopened = await reopen().open(identity());

    // Assert
    should(reopened.devices.map(device => device.id)).deepEqual(['fy_device_id_bbbbbbbbbbbbbbbbbbbbbb']);
  });

  it('should refuse to list or remove before the state home is open', async () => {
    const { repository } = fixture();

    await should(repository.list()).be.rejectedWith('pairing state is not open');
    await should(repository.remove('fy_device_id_aaaaaaaaaaaaaaaaaaaaaa')).be.rejectedWith('pairing state is not open');
  });
});

describe('StatePairingRepository device keys', () => {
  it('should refuse a grant whose key is not an Ed25519 public key, rather than store a device that can never get in', async () => {
    const { repository } = fixture();
    const state = await repository.open(identity());
    await should(
      repository.add({ ...record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'), publicKey: 'not-a-key' }),
    ).be.rejected();
    should(await repository.list()).be.empty();
  });

  it('should record when a device was last seen, durably, and write nothing for one it does not hold', async () => {
    const { repository, document, reopen } = fixture();
    const state = await repository.open(identity());
    await repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));
    const before = document();

    await repository.touch('fy_device_id_cccccccccccccccccccccc', '2026-08-04T12:00:00.000Z');
    should(document()).equal(before);

    await repository.touch('fy_device_id_aaaaaaaaaaaaaaaaaaaaaa', '2026-08-04T12:00:00.000Z');
    const reopened = await reopen().open(identity());
    should(reopened.devices[0]?.lastSeenAt).equal('2026-08-04T12:00:00.000Z');
    should(reopened.devices[0]?.publicKey).equal(DEVICE_KEY);
  });

  it('should change one device’s grants durably, and write nothing for a device it does not hold', async () => {
    // Arrange
    const { repository, document, reopen } = fixture();
    const state = await repository.open(identity());
    await repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));
    const before = document();

    // Act
    const missing = await repository.setGrants('fy_device_id_cccccccccccccccccccccc', FULL_DEVICE_GRANTS);
    const unchanged = document();
    const changed = await repository.setGrants('fy_device_id_aaaaaaaaaaaaaaaaaaaaaa', FULL_DEVICE_GRANTS);
    const reopened = await reopen().open(identity());

    // Assert
    should([missing, changed]).deepEqual([false, true]);
    should(unchanged).equal(before);
    should(reopened.devices[0]?.grants).deepEqual(FULL_DEVICE_GRANTS);
  });

  it('should replace one device’s key durably with when it happened, and write nothing for a device it does not hold', async () => {
    // Arrange
    const { repository, document, reopen } = fixture();
    const state = await repository.open(identity());
    await repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));
    const before = document();

    // Act
    const missing = await repository.rotateKey(
      'fy_device_id_cccccccccccccccccccccc',
      ROTATED_KEY,
      '2026-08-05T12:00:00.000Z',
    );
    const unchanged = document();
    const rotated = await repository.rotateKey(
      'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa',
      ROTATED_KEY,
      '2026-08-05T12:00:00.000Z',
    );
    const reopened = await reopen().open(identity());

    // Assert
    should([missing, rotated]).deepEqual([false, true]);
    should(unchanged).equal(before);
    should(reopened.devices[0]?.publicKey).equal(ROTATED_KEY);
    should(reopened.devices[0]?.keyRotatedAt).equal('2026-08-05T12:00:00.000Z');
  });

  it('G141 should refuse a device grant document whose grants are malformed or missing, rather than guess', async () => {
    // The kept half of G141: a malformed `grants` fails the document closed, and a missing one is no longer filled in.
    const bad = { ...record(DAEMON_ID, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'), grants: { fleet: { use: 'yes' } } };
    const malformed = fixture();
    malformed.folder.plant(DevicesFile, JSON.stringify({ format: 1, daemonId: DAEMON_ID, devices: [bad] }));
    await should(malformed.repository.open(identity())).be.rejected();

    const { grants: _absent, ...withoutGrants } = record(DAEMON_ID, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa');
    const missing = fixture();
    missing.folder.plant(DevicesFile, JSON.stringify({ format: 1, daemonId: DAEMON_ID, devices: [withoutGrants] }));
    await should(missing.repository.open(identity())).be.rejected();
  });
});

describe('StatePairingRepository keeps only the public half', () => {
  it('P4 the device record on disk holds the public key and no private half, token or digest', async () => {
    const { repository, document } = fixture();
    const state = await repository.open(identity());
    await repository.add(record(state.daemonId, 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa'));

    const written = JSON.parse(document() ?? '{}') as { devices: Record<string, unknown>[] };

    should(Object.keys(written.devices[0] ?? {}).sort()).deepEqual(
      ['createdAt', 'daemonId', 'grants', 'id', 'lastSeenAt', 'name', 'platform', 'publicKey'].sort(),
    );
    should(written.devices[0]?.publicKey).equal(DEVICE_KEY);
  });
});
