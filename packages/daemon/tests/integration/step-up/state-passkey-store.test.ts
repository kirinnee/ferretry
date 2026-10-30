import { afterAll, describe, it } from 'bun:test';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { PasskeyStoreDamaged, StatePasskeyStore } from '../../../src/adapters/step-up/index.ts';
import {
  createFoundationPaths,
  type FileSystemPort,
  resolveStateHome,
  type StoredPasskey,
} from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

afterAll(async () => {
  await cleanupTempDirectories();
});

type StoreFiles = Pick<FileSystemPort, 'readText' | 'writeTextAtomic' | 'setMode'>;

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

async function fixture(label: string, wrap: (files: StateFileSystem) => StoreFiles = files => files) {
  const home = await tempDirectory(label);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  await files.ensureDirectory(paths.state, 0o700);
  const path = join(paths.state, 'passkeys.json');
  return { files, path, store: new StatePasskeyStore(paths, wrap(files)) };
}

/** Yield one turn of the event loop, no time: enough for a second caller to interleave with an unserialized one. */
const nextTurn = async (): Promise<void> => {
  await new Promise<void>(resolve => setImmediate(resolve));
};

describe('StatePasskeyStore', () => {
  it('should read as no passkeys when the document does not exist yet', async () => {
    // Arrange
    const { store, path } = await fixture('passkeys-absent');

    // Act
    const listed = await store.list(deviceOne);

    // Assert
    should(listed).deepEqual([]);
    should(await Bun.file(path).exists()).equal(false);
  });

  it('should round-trip a passkey, keeping each device’s passkeys apart', async () => {
    // Arrange
    const { store } = await fixture('passkeys-round-trip');

    // Act
    await store.add(passkey('cred-one'));
    await store.add(passkey('cred-two'));
    await store.add(passkey('cred-other', deviceTwo));

    // Assert
    should((await store.list(deviceOne)).map(entry => entry.credentialId)).deepEqual(['cred-one', 'cred-two']);
    should(await store.list(deviceTwo)).deepEqual([passkey('cred-other', deviceTwo)]);
    should(await store.list(`fy_device_id_${'z'.repeat(22)}`)).deepEqual([]);
  });

  it('should replace a passkey added again under the same credential id', async () => {
    // Arrange
    const { store } = await fixture('passkeys-replace');
    await store.add(passkey('cred-one', deviceOne, { signCount: 1 }));

    // Act
    await store.add(passkey('cred-one', deviceOne, { signCount: 9 }));

    // Assert
    should(await store.list(deviceOne)).deepEqual([passkey('cred-one', deviceOne, { signCount: 9 })]);
  });

  it('should record a new counter for exactly the named passkey', async () => {
    // Arrange
    const { store } = await fixture('passkeys-sign-count');
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
    const { store } = await fixture('passkeys-sign-count-cas');
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
    const { store } = await fixture('passkeys-sign-count-race');
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
    // to whoever registered the same id. It used to be re-pointed.
    // Arrange
    const { store } = await fixture('passkeys-global-unique');
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
    const { store } = await fixture('passkeys-sign-count-gone');
    await store.add(passkey('cred-one'));

    // Act
    const moved = await store.updateSignCount(deviceOne, 'vanished', 7);

    // Assert
    should(moved).be.false();
    should(await store.list(deviceOne)).deepEqual([passkey('cred-one')]);
  });

  it('should forget every passkey of one device and no other', async () => {
    // Arrange
    const { store } = await fixture('passkeys-forget');
    await store.add(passkey('cred-one'));
    await store.add(passkey('cred-two'));
    await store.add(passkey('cred-other', deviceTwo));

    // Act
    await store.forgetDevice(deviceOne);

    // Assert
    should(await store.list(deviceOne)).deepEqual([]);
    should(await store.list(deviceTwo)).deepEqual([passkey('cred-other', deviceTwo)]);
  });

  it('should leave the document owner-only after a write', async () => {
    // Arrange
    const { store, path } = await fixture('passkeys-mode');

    // Act
    await store.add(passkey('cred-one'));
    await store.updateSignCount(deviceOne, 'cred-one', 3);

    // Assert
    should((await stat(path)).mode & 0o777).equal(0o600);
  });

  it('should keep both passkeys when two registrations are in flight at once', async () => {
    // Arrange — a read that yields long enough that, unserialized, both adds would read the empty
    // document and the second write would erase the first
    const { store } = await fixture('passkeys-concurrent', files => ({
      readText: async path => {
        const text = await files.readText(path);
        await nextTurn();
        return text;
      },
      writeTextAtomic: async (path, text) => await files.writeTextAtomic(path, text),
      setMode: async (path, mode) => await files.setMode(path, mode),
    }));

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
    const { store, path } = await fixture('passkeys-failed-write', files => ({
      readText: async path => await files.readText(path),
      writeTextAtomic: async (path, text) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('disk full');
        }
        await files.writeTextAtomic(path, text);
      },
      setMode: async (path, mode) => await files.setMode(path, mode),
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
    should(await Bun.file(path).exists()).equal(true);
  });

  describe('a document that cannot be read as passkeys', () => {
    const duplicated = {
      schemaVersion: 1,
      passkeys: [passkey('cred-one'), passkey('cred-one', deviceTwo)],
    };
    const cases: readonly (readonly [string, string, RegExp])[] = [
      ['is not JSON', '{ not json', /not valid JSON/u],
      ['has the wrong schema version', JSON.stringify({ schemaVersion: 2, passkeys: [] }), /does not describe/u],
      [
        'holds a row with an unknown field',
        JSON.stringify({ schemaVersion: 1, passkeys: [{ extra: 1 }] }),
        /does not describe/u,
      ],
      ['holds one credential twice', JSON.stringify(duplicated), /one credential twice/u],
    ];

    for (const [name, contents, message] of cases) {
      it(`should fail closed, never read as empty, when the document ${name}`, async () => {
        // Arrange
        const { files, path, store } = await fixture('passkeys-damaged');
        await files.writeTextAtomic(path, contents);

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
        should(await Bun.file(path).text()).equal(contents);
      });
    }
  });
});
