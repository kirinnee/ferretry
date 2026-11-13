import { describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { PasskeysFile } from '../../../../contract/index.ts';
import { PasskeyStoreDamaged, StatePasskeyStore } from '../../../../daemon/adapters/step-up/state-passkey-store.ts';
import type { StoredPasskey } from '../../../../daemon/lib/step-up/index.ts';

const deviceOne = `fy_device_id_${'a'.repeat(22)}`;
const deviceTwo = `fy_device_id_${'b'.repeat(22)}`;

function passkey(credentialId: string, deviceId = deviceOne, overrides: Partial<StoredPasskey> = {}): StoredPasskey {
  return {
    credentialId,
    deviceId,
    algorithm: -7,
    publicKeySpki: 'c3BraQ',
    signCount: 0,
    origin: 'https://app.example.test',
    createdAt: '2026-08-03T12:00:00.000Z',
    ...overrides,
  };
}

function fixture(wrap: (state: StatePort) => StatePort = state => state) {
  const folder = new MemoryStateFolder();
  const state = folder.port([PasskeysFile]);
  return { folder, state, store: new StatePasskeyStore(wrap(state)) };
}

describe('StatePasskeyStore', () => {
  it('should read as no passkeys when the document does not exist yet', async () => {
    // Arrange
    const { store, folder } = fixture();

    // Act
    const listed = await store.list(deviceOne);

    // Assert
    should(listed).deepEqual([]);
    should(folder.raw(PasskeysFile)).be.undefined();
  });

  it('should say whether ANY device holds a passkey, from the file', async () => {
    // Arrange
    const { store } = fixture();
    const before = await store.any();

    // Act
    await store.add(passkey('cred-any', deviceTwo));

    // Assert — none, then one on another device: saving a 2FA seed asks only that one exists
    should(before).be.false();
    should(await store.any()).be.true();
  });

  it('should round-trip a passkey, keeping each device’s passkeys apart', async () => {
    // Arrange
    const { store } = fixture();

    // Act
    await store.add(passkey('cred-one'));
    await store.add(passkey('cred-two'));
    await store.add(passkey('cred-other', deviceTwo));

    // Assert
    should((await store.list(deviceOne)).map(entry => entry.credentialId)).deepEqual(['cred-one', 'cred-two']);
    should(await store.list(deviceTwo)).deepEqual([passkey('cred-other', deviceTwo)]);
    should(await store.list(`fy_device_id_${'z'.repeat(22)}`)).deepEqual([]);
  });

  it('should refuse a passkey added again under the same credential id, and keep the first', async () => {
    // A new key or origin under a known id would quietly change what a kept proof is checked against.
    // Arrange
    const { store } = fixture();
    await store.add(passkey('cred-one', deviceOne, { signCount: 1 }));

    // Act
    const replaced = await store
      .add(passkey('cred-one', deviceOne, { signCount: 9, origin: 'https://other.example' }))
      .then(
        () => 'replaced',
        (error: unknown) => (error instanceof PasskeyStoreDamaged ? error.message : 'other'),
      );

    // Assert
    should(replaced).equal('that credential is already stored, and is never replaced');
    should(await store.list(deviceOne)).deepEqual([passkey('cred-one', deviceOne, { signCount: 1 })]);
  });

  it('should record a new counter for exactly the named passkey', async () => {
    // Arrange
    const { store } = fixture();
    await store.add(passkey('cred-one'));
    await store.add(passkey('cred-two'));
    await store.add(passkey('cred-other', deviceTwo));

    // Act
    const moved = await store.updateSignCount(deviceOne, 'cred-one', 42);
    const misnamed = await store.updateSignCount(deviceTwo, 'cred-two', 99);

    // Assert — the pair names one row: another device's counter is untouched, and a credential id
    // that belongs to a different device than the one named is not updated
    should((await store.list(deviceOne)).map(entry => [entry.credentialId, entry.signCount])).deepEqual([
      ['cred-one', 42],
      ['cred-two', 0],
    ]);
    should((await store.list(deviceTwo)).map(entry => entry.signCount)).deepEqual([0]);
    should([moved, misnamed]).deepEqual([true, false]);
  });

  it('should compare-and-set the counter: never rewind or stall it, but let a counterless authenticator stay at zero', async () => {
    // Arrange
    const { store } = fixture();
    await store.add(passkey('cred-one'));
    await store.add(passkey('cred-zero'));

    // Act
    const forward = await store.updateSignCount(deviceOne, 'cred-one', 7);
    const stuck = await store.updateSignCount(deviceOne, 'cred-one', 7);
    const rewound = await store.updateSignCount(deviceOne, 'cred-one', 6);
    const counterless = await store.updateSignCount(deviceOne, 'cred-zero', 0);

    // Assert
    should([forward, stuck, rewound, counterless]).deepEqual([true, false, false, true]);
    should((await store.list(deviceOne)).map(entry => [entry.credentialId, entry.signCount])).deepEqual([
      ['cred-one', 7],
      ['cred-zero', 0],
    ]);
  });

  it('should let only one of two concurrent assertions verified against the same count land, and never rewind', async () => {
    // Two tabs of one device verified against stored 0; one reports 7, the other 6 (review L2).
    // Arrange
    const { store } = fixture();
    await store.add(passkey('cred-one'));

    // Act — both in flight at once, the higher one first
    const [seven, six] = await Promise.all([
      store.updateSignCount(deviceOne, 'cred-one', 7),
      store.updateSignCount(deviceOne, 'cred-one', 6),
    ]);

    // Assert
    should([seven, six]).deepEqual([true, false]);
    should((await store.list(deviceOne)).map(entry => entry.signCount)).deepEqual([7]);
  });

  it('should bind a credential id to the device that registered it, and never re-point it to another', async () => {
    // A synced passkey, or an id another device learned: re-pointing it would hand this device's passkey
    // to whoever registered the same id.
    // Arrange
    const { store } = fixture();
    await store.add(passkey('cred-one'));

    // Act
    const moved = await store.add(passkey('cred-one', deviceTwo)).then(
      () => 'moved',
      (error: unknown) => (error instanceof PasskeyStoreDamaged ? error.message : 'other'),
    );

    // Assert
    should(moved).equal('that credential already belongs to another device');
    should(await store.list(deviceOne)).deepEqual([passkey('cred-one')]);
    should(await store.list(deviceTwo)).deepEqual([]);
    should(await store.holder('cred-one')).equal(deviceOne);
    should(await store.holder('cred-unknown')).be.undefined();
  });

  it('should treat a counter update for a passkey that is gone as nothing to do', async () => {
    // Arrange
    const { store } = fixture();
    await store.add(passkey('cred-one'));

    // Act
    const moved = await store.updateSignCount(deviceOne, 'vanished', 7);

    // Assert
    should(moved).be.false();
    should(await store.list(deviceOne)).deepEqual([passkey('cred-one')]);
  });

  it('should forget every passkey of one device and no other', async () => {
    // Arrange
    const { store } = fixture();
    await store.add(passkey('cred-one'));
    await store.add(passkey('cred-two'));
    await store.add(passkey('cred-other', deviceTwo));

    // Act
    await store.forgetDevice(deviceOne);

    // Assert
    should(await store.list(deviceOne)).deepEqual([]);
    should(await store.list(deviceTwo)).deepEqual([passkey('cred-other', deviceTwo)]);
  });

  it('should declare the document owner-only', () => {
    // The kernel's state port writes a declared file with its declared mode.
    should(PasskeysFile.mode).equal(0o600);
  });

  it('should keep both passkeys when two registrations are in flight at once', async () => {
    // Arrange
    const { store } = fixture();

    // Act
    await Promise.all([
      store.add(passkey('cred-one')),
      store.add(passkey('cred-two')),
      store.add(passkey('cred-three')),
    ]);

    // Assert
    should((await store.list(deviceOne)).map(entry => entry.credentialId).sort()).deepEqual([
      'cred-one',
      'cred-three',
      'cred-two',
    ]);
  });

  it('should not let one failed write poison the next mutation', async () => {
    // Arrange
    let failures = 1;
    const { store, folder } = fixture(state => ({
      ...state,
      update: (file, fn, name) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(new Error('disk full'));
        }
        return state.update(file, fn, name);
      },
    }));

    // Act
    const failed = store.add(passkey('cred-lost')).then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    const survivor = store.add(passkey('cred-kept'));
    await survivor;

    // Assert
    should(await failed).equal('disk full');
    should((await store.list(deviceOne)).map(entry => entry.credentialId)).deepEqual(['cred-kept']);
    should(folder.raw(PasskeysFile)).not.be.undefined();
  });

  describe('a document that cannot be read as passkeys', () => {
    const duplicated = {
      format: 1,
      passkeys: [passkey('cred-one'), passkey('cred-one', deviceTwo)],
    };
    const cases: readonly (readonly [string, string, RegExp])[] = [
      ['is not JSON', '{ not json', /does not describe/u],
      ['has another format', JSON.stringify({ format: 2, passkeys: [] }), /does not describe/u],
      [
        'holds a row with an unknown field',
        JSON.stringify({ format: 1, passkeys: [{ extra: 1 }] }),
        /does not describe/u,
      ],
      ['holds one credential twice', JSON.stringify(duplicated), /one credential twice/u],
    ];

    for (const [name, contents, message] of cases) {
      it(`should fail closed, never read as empty, when the document ${name}`, async () => {
        // Arrange
        const { folder, store } = fixture();
        folder.plant(PasskeysFile, contents);

        // Act
        const listed = await store.list(deviceOne).then(
          () => undefined,
          (error: unknown) => error,
        );
        const added = await store.add(passkey('cred-new')).then(
          () => undefined,
          (error: unknown) => error,
        );

        // Assert — and the damaged file is left exactly as found, for somebody to look at
        should(listed).be.instanceOf(PasskeyStoreDamaged);
        should((listed as Error).message).match(message);
        should(added).be.instanceOf(PasskeyStoreDamaged);
        should(folder.raw(PasskeysFile)).equal(contents);
      });
    }
  });
});
