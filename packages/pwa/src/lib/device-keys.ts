/**
 * THE KEY THIS BROWSER PROVES ITS PAIRING WITH, AND WHERE IT IS KEPT.
 *
 * A paired browser holds no bearer value. At pairing it generates an Ed25519 key pair with the private
 * half NON-EXTRACTABLE, hands the daemon the public half, and from then on signs every session's
 * transcript with it (`docs/design/zero-trust.md` A1). This module is the browser's half of that key's
 * life: minting it, keeping it, finding it again, and forgetting it.
 *
 * WHERE: IndexedDB, one record per daemon, keyed by the daemon id. IndexedDB can hold a `CryptoKey`
 * object without ever holding its bytes — the structured clone of a non-extractable key is a reference
 * the browser honours, so `exportKey` on what comes back still throws, and a copy of the database
 * restored into another profile yields nothing usable. `localStorage` could only hold a string, which
 * would mean an extractable key, which is the bearer token again by another name.
 *
 * ONE KEY PER DAEMON. A browser paired with three machines holds three keys, so unpairing one forgets
 * only its own, and a key that leaked by any route would answer for one daemon only.
 *
 * WHAT IT CANNOT DO: protect the key from code running in this page. An XSS or a malicious deploy can
 * USE the key while the tab is open — it cannot carry it away — and that limit is stated in the design.
 */

import { toBase64Url } from '@ferretry/relay';

/** Said when a browser cannot mint the key Ferretry pairs with, which every supported browser can. */
export const UNSUPPORTED_DEVICE_KEY_SENTENCE =
  'This browser cannot create the kind of key Ferretry pairs with (Ed25519). Update the browser, or pair from a different one.';

/** Said when the key this browser paired with is gone — cleared site data, or a copied profile. */
const MISSING_DEVICE_KEY_SENTENCE =
  'This browser no longer holds the key it paired this machine with — its site data was cleared, or this is a copy of another profile. Pair this device again.';

/** The key a pairing was proved with is not in this browser any more. Re-pairing is the only repair. */
export class DeviceKeyMissingError extends Error {
  constructor() {
    super(MISSING_DEVICE_KEY_SENTENCE);
    this.name = 'DeviceKeyMissingError';
  }
}

/**
 * This browser could not READ its key store at all — private browsing with storage blocked, a quota
 * error, a profile the browser itself refuses. Not a missing key: the key may be there, unreachable.
 *
 * Final for the attempt, like a missing key. No carrier can do anything about this browser's storage,
 * and walking on would report a storage fault as "the network did not answer" five times over.
 */
export class DeviceKeyUnreadableError extends Error {
  constructor(cause: unknown) {
    super(
      `This browser could not read the key it pairs with (${cause instanceof Error ? cause.message : String(cause)}). ` +
        'If this is a private window or site storage is blocked, open Ferretry in a normal window.',
    );
    this.name = 'DeviceKeyUnreadableError';
    this.cause = cause;
  }
}

/** Where device keys live. A port so the session code never knows it is IndexedDB. */
export interface DeviceKeyStore {
  load(daemonId: string): Promise<CryptoKey | undefined>;
  save(daemonId: string, key: CryptoKey): Promise<void>;
  remove(daemonId: string): Promise<void>;
}

/** A freshly minted device key: the private half to keep, and the public half to register. */
export interface MintedDeviceKey {
  readonly privateKey: CryptoKey;
  /** The Ed25519 SPKI, base64url — the only thing the daemon will store about this browser. */
  readonly publicKey: string;
}

/** The one WebCrypto call this needs, so a suite can stand in for a browser that refuses Ed25519. */
export interface DeviceKeyGenerator {
  generateDeviceKey(): Promise<{ readonly publicKeySpki: Uint8Array; readonly privateKey: CryptoKey }>;
}

/**
 * A new non-extractable Ed25519 device key, or the one sentence that says this browser cannot make one.
 *
 * There is deliberately no fallback to a weaker or extractable key: the relay client already needs
 * WebCrypto Ed25519 to verify the daemon, so a browser without it could not have connected anyway.
 */
export async function mintDeviceKey(generator: DeviceKeyGenerator): Promise<MintedDeviceKey> {
  let generated: Awaited<ReturnType<DeviceKeyGenerator['generateDeviceKey']>>;
  try {
    generated = await generator.generateDeviceKey();
  } catch {
    throw new Error(UNSUPPORTED_DEVICE_KEY_SENTENCE);
  }
  return { privateKey: generated.privateKey, publicKey: toBase64Url(generated.publicKeySpki) };
}

/** The slice of `IDBFactory` this store uses, so a suite can supply one without a browser. */
export interface DeviceKeyDatabaseFactory {
  open(name: string, version?: number): IDBOpenDBRequest;
}

const DATABASE = 'ferretry-device-keys';
const STORE = 'keys';
const VERSION = 1;

const settled = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('the device key store refused a request'));
  });

/**
 * Device keys in IndexedDB.
 *
 * The database is opened per call rather than held: a held connection blocks the version change a
 * future build needs, and this store is touched once per pairing and once per session — never per
 * request — so reopening costs nothing anybody would notice.
 */
export class IndexedDbDeviceKeyStore implements DeviceKeyStore {
  constructor(private readonly factory: DeviceKeyDatabaseFactory | undefined = globalThis.indexedDB) {}

  async load(daemonId: string): Promise<CryptoKey | undefined> {
    const value = await this.#run('readonly', store => store.get(daemonId));
    return value instanceof CryptoKey ? value : undefined;
  }

  async save(daemonId: string, key: CryptoKey): Promise<void> {
    await this.#run('readwrite', store => store.put(key, daemonId));
  }

  async remove(daemonId: string): Promise<void> {
    await this.#run('readwrite', store => store.delete(daemonId));
  }

  async #run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const factory = this.factory;
    if (factory === undefined) throw new Error('this browser has no IndexedDB, so it cannot keep a device key');
    const opening = factory.open(DATABASE, VERSION);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(STORE)) opening.result.createObjectStore(STORE);
    };
    const database = await settled(opening);
    try {
      return await settled(action(database.transaction(STORE, mode).objectStore(STORE)));
    } finally {
      database.close();
    }
  }
}
