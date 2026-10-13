/**
 * The browser's device key: minted non-extractable, kept in IndexedDB, found again, forgotten.
 *
 * IndexedDB does not exist in this runtime, so the store is driven through a scripted factory that
 * implements exactly the slice `IndexedDbDeviceKeyStore` uses. The KEYS are real WebCrypto keys:
 * whether a value survives as a `CryptoKey`, and whether that key is extractable, are the two facts
 * this module exists to get right, and a fake key could prove neither.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  type DeviceKeyDatabaseFactory,
  DeviceKeyMissingError,
  DeviceKeyUnreadableError,
  DeviceKeyUnsupportedError,
  IndexedDbDeviceKeyStore,
  mintDeviceKey,
  UNSUPPORTED_DEVICE_KEY_SENTENCE,
} from '../../src/lib/device-keys.ts';
import { relayCrypto } from '../support/relay.ts';

interface ScriptedRequest<T> {
  result: T;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
}

const succeeds = <T>(result: T): ScriptedRequest<T> => {
  const request: ScriptedRequest<T> = { result, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => request.onsuccess?.());
  return request;
};

const fails = <T>(error: DOMException | null): ScriptedRequest<T> => {
  const request: ScriptedRequest<T> = { result: undefined as T, error, onsuccess: null, onerror: null };
  queueMicrotask(() => request.onerror?.());
  return request;
};

/** An IndexedDB that holds one database, and records everything a suite needs to ask it about. */
class ScriptedIndexedDb implements DeviceKeyDatabaseFactory {
  readonly values = new Map<string, unknown>();
  readonly stores = new Set<string>();
  readonly opened: { name: string; version?: number }[] = [];
  upgrades = 0;
  closes = 0;
  failOpen: DOMException | null | undefined;
  failAction: DOMException | null | undefined;

  open(name: string, version?: number): IDBOpenDBRequest {
    this.opened.push({ name, version });
    if (this.failOpen !== undefined) return fails(this.failOpen) as unknown as IDBOpenDBRequest;
    const database = {
      objectStoreNames: { contains: (store: string) => this.stores.has(store) },
      createObjectStore: (store: string) => {
        this.stores.add(store);
      },
      close: () => {
        this.closes += 1;
      },
      transaction: (_store: string, _mode: IDBTransactionMode) => ({
        objectStore: () => ({
          get: (key: string) => (this.failAction !== undefined ? fails(this.failAction) : succeeds(this.values.get(key))),
          put: (value: unknown, key: string) => {
            if (this.failAction !== undefined) return fails(this.failAction);
            this.values.set(key, value);
            return succeeds(key);
          },
          delete: (key: string) => {
            if (this.failAction !== undefined) return fails(this.failAction);
            this.values.delete(key);
            return succeeds(undefined);
          },
        }),
      }),
    };
    const request: ScriptedRequest<unknown> = {
      result: database,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };
    queueMicrotask(() => {
      // A real database fires `upgradeneeded` once, on first open at a new version.
      if (this.upgrades === 0) {
        this.upgrades += 1;
        request.onupgradeneeded?.();
      } else if (!this.stores.has('keys')) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

const freshKey = async (): Promise<CryptoKey> => (await relayCrypto.generateDeviceKey()).privateKey;

describe('minting a device key', () => {
  it('should mint a non-extractable private key and hand back only the public SPKI', async () => {
    const minted = await mintDeviceKey(relayCrypto);
    should(minted.privateKey.extractable).be.false();
    should(minted.privateKey.type).equal('private');
    // A 44-byte Ed25519 SPKI is 59 base64url characters, unpadded.
    should(minted.publicKey).match(/^[A-Za-z0-9_-]{59}$/u);
    await should(crypto.subtle.exportKey('pkcs8', minted.privateKey)).be.rejected();
  });

  it('should say plainly when this browser cannot make one, and fall back to nothing weaker', async () => {
    const refusing = {
      generateDeviceKey: async () => {
        throw new DOMException('Unrecognized name', 'NotSupportedError');
      },
    };
    const refusal = await mintDeviceKey(refusing).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    should(refusal).be.instanceof(DeviceKeyUnsupportedError);
    should((refusal as Error).message).equal(UNSUPPORTED_DEVICE_KEY_SENTENCE);
    should((refusal as Error).name).equal('DeviceKeyUnsupportedError');
  });
});

describe('the IndexedDB device key store', () => {
  it('should keep a key under its daemon, return it as a CryptoKey, and close the database each time', async () => {
    const database = new ScriptedIndexedDb();
    const store = new IndexedDbDeviceKeyStore(database);
    const key = await freshKey();

    await store.save('fy_daemon_a', key);
    const loaded = await store.load('fy_daemon_a');

    should(loaded).equal(key);
    should(loaded?.extractable).be.false();
    should(database.opened).eql([
      { name: 'ferretry-device-keys', version: 1 },
      { name: 'ferretry-device-keys', version: 1 },
    ]);
    should([...database.stores]).eql(['keys']);
    // Held connections block a future version change; this store holds none.
    should(database.closes).equal(2);
  });

  it('should keep one key per daemon, so forgetting one leaves the others', async () => {
    const database = new ScriptedIndexedDb();
    const store = new IndexedDbDeviceKeyStore(database);
    const [first, second] = [await freshKey(), await freshKey()];
    await store.save('fy_daemon_a', first);
    await store.save('fy_daemon_b', second);

    await store.remove('fy_daemon_a');

    should(await store.load('fy_daemon_a')).be.undefined();
    should(await store.load('fy_daemon_b')).equal(second);
  });

  it('should answer nothing for a value that is not a key, rather than handing back what it found', async () => {
    const database = new ScriptedIndexedDb();
    database.stores.add('keys');
    database.values.set('fy_daemon_a', 'an extractable string from somewhere else');
    should(await new IndexedDbDeviceKeyStore(database).load('fy_daemon_a')).be.undefined();
  });

  it('should refuse plainly when this browser has no IndexedDB at all', async () => {
    const store = new IndexedDbDeviceKeyStore(undefined);
    await should(store.load('fy_daemon_a')).be.rejectedWith(/no IndexedDB/u);
  });

  it('should default to the browser’s own IndexedDB', async () => {
    const host = globalThis as { indexedDB?: unknown };
    const had = 'indexedDB' in host;
    const previous = host.indexedDB;
    const database = new ScriptedIndexedDb();
    host.indexedDB = database;
    try {
      await new IndexedDbDeviceKeyStore().save('fy_daemon_a', await freshKey());
    } finally {
      if (had) host.indexedDB = previous;
      else delete host.indexedDB;
    }
    should(database.values.has('fy_daemon_a')).be.true();
  });

  it('should carry the browser’s own reason when opening or an action fails, and a sentence when it gave none', async () => {
    const blocked = new ScriptedIndexedDb();
    blocked.failOpen = new DOMException('The user denied permission to access the database.', 'SecurityError');
    await should(new IndexedDbDeviceKeyStore(blocked).load('fy_daemon_a')).be.rejectedWith(/denied permission/u);

    const silent = new ScriptedIndexedDb();
    silent.failOpen = null;
    await should(new IndexedDbDeviceKeyStore(silent).load('fy_daemon_a')).be.rejectedWith(
      'the device key store refused a request',
    );

    const full = new ScriptedIndexedDb();
    full.failAction = new DOMException('quota exceeded', 'QuotaExceededError');
    await should(new IndexedDbDeviceKeyStore(full).save('fy_daemon_a', await freshKey())).be.rejectedWith(/quota/u);
    // The database is closed even when the action inside it failed.
    should(full.closes).equal(1);
  });
});

describe('the two ways a key can be unavailable', () => {
  it('should tell a missing key, which re-pairing fixes, from an unreadable store, which it does not', () => {
    const missing = new DeviceKeyMissingError();
    should(missing.name).equal('DeviceKeyMissingError');
    should(missing.message).match(/Pair this device again/u);

    const unreadable = new DeviceKeyUnreadableError(new Error('storage is blocked'));
    should(unreadable.name).equal('DeviceKeyUnreadableError');
    should(unreadable.message).match(/storage is blocked.*normal window/u);
    should(unreadable.cause).be.instanceof(Error);
    should(new DeviceKeyUnreadableError('plain').message).match(/\(plain\)/u);
  });
});
