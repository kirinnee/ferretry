import { describe, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { StatePairingRepository } from '../../../../daemon/adapters/pairing/index.ts';
import type { PairingDeviceRecord } from '../../../../daemon/lib/pairing/index.ts';
import { type DaemonId, DevicesFile, LIMITED_DEVICE_GRANTS } from '../../../../daemon/lib/wire.ts';

/**
 * What the paired-device document holds on disk, proved over the in-memory Access state (the kernel store's rules,
 * no disk): the document keeps the device's PUBLIC key and nothing that could authenticate as the device.
 */

const DAEMON_ID = `fy_daemon_${'a'.repeat(43)}` as DaemonId;
const DEVICE_ID = 'fy_device_id_aaaaaaaaaaaaaaaaaaaaaa';

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

function fixture() {
  const folder = new MemoryStateFolder();
  return {
    folder,
    repository: new StatePairingRepository(folder.port([DevicesFile])),
    reopen: () => new StatePairingRepository(folder.port([DevicesFile])),
    document: () => folder.raw(DevicesFile),
  };
}

const identity = (daemonName = 'workstation') => ({ daemonId: DAEMON_ID, daemonName });

function record(daemonId: DaemonId): PairingDeviceRecord {
  return {
    id: DEVICE_ID,
    daemonId,
    name: 'Browser device',
    platform: 'browser',
    createdAt: '2026-08-03T12:00:00.000Z',
    lastSeenAt: '2026-08-03T12:00:00.000Z',
    publicKey: DEVICE_KEY,
    grants: LIMITED_DEVICE_GRANTS,
  };
}

describe('StatePairingRepository keeps only the public half', () => {
  it('P4 the device record on disk holds the public key and no private half, token or digest', async () => {
    const { repository, document } = fixture();
    const state = await repository.open(identity());
    await repository.add(record(state.daemonId));

    const written = JSON.parse(document() ?? '{}') as { devices: Record<string, unknown>[] };

    should(Object.keys(written.devices[0] ?? {}).sort()).deepEqual(
      ['createdAt', 'daemonId', 'grants', 'id', 'lastSeenAt', 'name', 'platform', 'publicKey'].sort(),
    );
    should(written.devices[0]?.publicKey).equal(DEVICE_KEY);
  });

  it('P10 should persist the device key as SPKI under the same daemon identity, and nothing that authenticates', async () => {
    const { repository, document, reopen } = fixture();
    const before = await repository.open(identity());
    await repository.add(record(before.daemonId));

    const written = document() ?? '';
    const after = await reopen().open(identity('renamed workstation'));

    should(JSON.parse(written).devices[0].publicKey).equal(DEVICE_KEY);
    should(written).not.match(/token|hash|privateKey/iu);
    should(after.daemonId).equal(before.daemonId);
    should(after.daemonName).equal('renamed workstation');
    should(after.devices).have.length(1);
  });
});
