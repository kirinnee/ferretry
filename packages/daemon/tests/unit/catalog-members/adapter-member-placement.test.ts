import { describe, it } from 'bun:test';
import { CatalogMemberKeyIdSchema } from '@ferretry/protocol';
import should from 'should';
import { PasskeyStoreDamaged, StatePasskeyStore, StateUnlockLedger } from '../../../src/adapters/step-up/index.ts';
import type { FoundationPaths, StoredPasskey } from '../../../src/lib/index.ts';
import { keyId, T0 } from './support.ts';

/**
 * The step-up stores answer for paired devices by default and for member KEYS when placed elsewhere: the same
 * documents, another file, another owner id.
 */

class FakeFiles {
  readonly files = new Map<string, string>();
  readonly modes = new Map<string, number>();
  async readText(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  async writeTextAtomic(path: string, text: string): Promise<void> {
    this.files.set(path, text);
  }
  async setMode(path: string, mode: number): Promise<void> {
    this.modes.set(path, mode);
  }
}

const PATHS = { state: '/state' } as unknown as FoundationPaths;
const PASSKEYS = '/state/catalogs/member-passkeys.json';
const UNLOCKS = '/state/catalogs/member-unlocks.json';
const DEVICE = `fy_device_id_${'a'.repeat(22)}`;
const DAEMON = 'fy_daemon_this-machine';

const passkey = (deviceId: string, credentialId = 'Y3JlZA'): StoredPasskey => ({
  credentialId,
  deviceId,
  algorithm: -7,
  publicKeySpki: 'c3BraQ',
  signCount: 0,
  origin: 'https://app.example.test',
  createdAt: '2026-08-03T12:00:00.000Z',
});

describe('StatePasskeyStore placement', () => {
  it('should keep member passkeys by key id in the file it was placed at, owner-only', async () => {
    // Arrange
    const files = new FakeFiles();
    const store = new StatePasskeyStore(PATHS, files, { path: PASSKEYS, owner: CatalogMemberKeyIdSchema });

    // Act
    await store.add(passkey(keyId(1)));

    // Assert
    should((await store.list(keyId(1))).map(row => row.credentialId)).eql(['Y3JlZA']);
    should(await store.holder('Y3JlZA')).equal(keyId(1));
    should([...files.files.keys()]).eql([PASSKEYS]);
    should(files.modes.get(PASSKEYS)).equal(0o600);
  });

  it('should refuse a paired device id in a member placement, on write and on read', async () => {
    // Arrange
    const files = new FakeFiles();
    const store = new StatePasskeyStore(PATHS, files, { path: PASSKEYS, owner: CatalogMemberKeyIdSchema });
    files.files.set(PASSKEYS, `${JSON.stringify({ schemaVersion: 1, passkeys: [passkey(DEVICE)] })}\n`);

    // Act / Assert
    await store.add(passkey(DEVICE, 'b3RoZXI')).then(
      () => should.fail(undefined, undefined, 'a device id was filed as a member key'),
      error => should(error).be.instanceOf(PasskeyStoreDamaged),
    );
    await store.list(keyId(1)).then(
      () => should.fail(undefined, undefined, 'a device id was read as a member key'),
      error => should(error).be.instanceOf(PasskeyStoreDamaged),
    );
  });

  it('should refuse a member key id in the default placement, which belongs to paired devices', async () => {
    // Arrange
    const files = new FakeFiles();
    const store = new StatePasskeyStore(PATHS, files);

    // Act
    await store.add(passkey(DEVICE));
    const listed = await store.list(DEVICE);
    const refused = await store.add(passkey(keyId(1), 'b3RoZXI')).then(
      () => 'added',
      () => 'refused',
    );

    // Assert
    should(listed.length).equal(1);
    should([...files.files.keys()]).eql(['/state/passkeys.json']);
    should(refused).equal('refused');
  });
});

describe('StateUnlockLedger placement', () => {
  it('should keep member unlocks by key id in the file it was placed at, owner-only', async () => {
    // Arrange
    const files = new FakeFiles();
    const ledger = new StateUnlockLedger(PATHS, files, DAEMON, { path: UNLOCKS, owner: CatalogMemberKeyIdSchema });

    // Act
    await ledger.write(new Map([[keyId(1), T0]]));

    // Assert
    should([...(await ledger.read())]).eql([[keyId(1), T0]]);
    should([...files.files.keys()]).eql([UNLOCKS]);
    should(files.modes.get(UNLOCKS)).equal(0o600);
  });

  it('should refuse a paired device id in a member placement', async () => {
    // Arrange
    const files = new FakeFiles();
    const ledger = new StateUnlockLedger(PATHS, files, DAEMON, { path: UNLOCKS, owner: CatalogMemberKeyIdSchema });

    // Act / Assert
    await ledger.write(new Map([[DEVICE, T0]])).then(
      () => should.fail(undefined, undefined, 'a device id was filed as a member key'),
      error => should(error).be.instanceOf(Error),
    );
    files.files.set(
      UNLOCKS,
      JSON.stringify({
        schemaVersion: 1,
        daemonId: DAEMON,
        unlocks: [{ deviceId: DEVICE, unlockedAt: new Date(T0).toISOString() }],
      }),
    );
    await ledger.read().then(
      () => should.fail(undefined, undefined, 'a device id was read as a member key'),
      error => should(error).be.instanceOf(Error),
    );
  });

  it('should keep the paired devices unlocks in unlocks.json by default', async () => {
    // Arrange
    const files = new FakeFiles();
    const ledger = new StateUnlockLedger(PATHS, files, DAEMON);

    // Act
    await ledger.write(new Map([[DEVICE, T0]]));

    // Assert
    should([...files.files.keys()]).eql(['/state/unlocks.json']);
    should([...(await ledger.read())]).eql([[DEVICE, T0]]);
  });
});
