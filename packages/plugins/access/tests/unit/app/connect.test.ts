import { describe, it } from 'bun:test';
import type { PairedDaemon } from '@ferretry/app';
import should from 'should';
import { accessClaims } from '../../../app/connect.ts';
import { DeviceKeyUnreadableError } from '../../../app/lib/device-keys.ts';
import { MemoryDeviceKeyStore, testDeviceKeyCrypto, type TestKeyHandle } from '../../support/app/device-keys.ts';

const DAEMON = `fy_daemon_${'a'.repeat(43)}`;

const paired = (daemon: string, deviceId = 'fy_device_id_one'): PairedDaemon => ({
  daemon,
  machine: 'workstation',
  deviceId,
  address: 'https://daemon.example.test',
  carriers: [],
  pairedAt: 1,
  lastSelectedAt: 1,
});

const answer = (daemonId: string) => ({
  deviceId: `fy_device_id_${'b'.repeat(22)}`,
  daemonId,
  daemonName: 'workstation',
  capabilities: ['daemon-api'],
  carriers: [{ kind: 'direct', url: 'https://daemon.example.test' }],
  idleExpiryDays: 30,
});

const claimsOver = (store: MemoryDeviceKeyStore) =>
  accessClaims(
    { crypto: testDeviceKeyCrypto as never, indexedDB: null },
    { store, appSession: 'page-load-1', deviceName: () => 'Chrome on Linux · K7Q2' },
  );

describe('the device claims Access provides the app shell', () => {
  it('answers no claim for a daemon this device holds no key for', async () => {
    const claims = claimsOver(new MemoryDeviceKeyStore());

    should(await claims.claim(paired(DAEMON))).be.undefined();
  });

  it('answers the stored key as a handle, with the grant it proves and this page load’s app session', async () => {
    const store = new MemoryDeviceKeyStore();
    const claims = claimsOver(store);
    const { privateKey } = await testDeviceKeyCrypto.generateDeviceKey();
    await store.save(DAEMON, privateKey);

    const claim = await claims.claim(paired(DAEMON, 'fy_device_id_two'));

    should(claim?.deviceId).equal('fy_device_id_two');
    should(claim?.appSession).equal('page-load-1');
    should((claim as unknown as { key: TestKeyHandle }).key.key).equal(privateKey);
  });

  it('says a key store it cannot read is unreadable, not missing', async () => {
    const store = new MemoryDeviceKeyStore();
    store.load = async () => {
      throw new Error('quota');
    };

    await claimsOver(store).claim(paired(DAEMON)).should.be.rejectedWith(DeviceKeyUnreadableError);
  });

  it('P28 mints a memory-only pairing key, offered under the browser’s own name, that writes nothing before save', async () => {
    const store = new MemoryDeviceKeyStore();

    const key = await claimsOver(store).pairingKey(DAEMON);

    should(key.deviceName).equal('Chrome on Linux · K7Q2');
    should(key.publicKey).match(/^[A-Za-z0-9_-]+$/u);
    should(store.keys.size).equal(0);
    should(store.pending.size).equal(0);
    should(store.saved).be.empty();
  });

  it('P28 saves the key when the paired answer names the daemon it was minted for, and claim() then finds it', async () => {
    const store = new MemoryDeviceKeyStore();
    const claims = claimsOver(store);
    const key = await claims.pairingKey(DAEMON);

    await key.save(answer(DAEMON));

    should(store.pending.size).equal(0);
    const claim = await claims.claim(paired(DAEMON, 'fy_device_id_two'));
    should((claim as unknown as { key: TestKeyHandle }).key.key).equal((key.key as TestKeyHandle).key);
  });

  it('P28 refuses to save on an answer that is not a pairing response or names another daemon, leaving nothing behind', async () => {
    const store = new MemoryDeviceKeyStore();
    const claims = claimsOver(store);
    const key = await claims.pairingKey(DAEMON);

    await key.save({ nope: true }).should.be.rejected();
    await key.save(answer(`fy_daemon_${'z'.repeat(43)}`)).should.be.rejectedWith(/minted for/u);

    should(store.keys.size).equal(0);
    should(store.saved).be.empty();
  });

  it('forgets the key when the pairing is removed', async () => {
    const store = new MemoryDeviceKeyStore();
    const claims = claimsOver(store);
    await (await claims.pairingKey(DAEMON)).save(answer(DAEMON));

    await claims.forget(DAEMON);

    should(store.keys.has(DAEMON)).be.false();
    should(store.pending.has(DAEMON)).be.false();
  });
});
