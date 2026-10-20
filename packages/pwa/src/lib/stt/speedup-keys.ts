/**
 * SPEED-UP KEYS THIS DEVICE HOLDS: a Groq or Cerebras key kept in this browser so dictation clean-up
 * calls the provider directly instead of going through a daemon (owner decision: one more round trip
 * to the daemon makes clean-up slow). `docs/secrets.md` › "Device-held speed-up keys" is the contract.
 *
 * WHAT THIS PROMISES, and nothing more:
 *
 * - THE VALUE GOES IN AND NEVER COMES BACK OUT. There is no getter. A key is written once, and from
 *   then on this module answers only whether one is saved and its last two characters. The one place
 *   it is decrypted is `send`, which puts it on ONE request to that provider's own host — a URL this
 *   module picks from the shared provider table, never one a caller hands in.
 * - ENCRYPTED AT REST. Each key is AES-GCM ciphertext under a wrapping key minted NON-EXTRACTABLE and
 *   kept in IndexedDB as a `CryptoKey` object, so a copy of the database restored into another
 *   profile, or read off the disk, yields ciphertext and a key reference nothing can open. The
 *   provider id is the additional data, so a record moved into the other provider's slot fails.
 * - THIS DEVICE ONLY. Nothing here is synced, copied by Copy settings, or sent to any daemon, and
 *   no agent can ever reach it: agents run on daemons, and the key is not on one.
 *
 * WHAT IT CANNOT DO: protect the key from code running in this page. An XSS or a malicious deploy can
 * spend it while the tab is open, exactly as `device-keys.ts` says of the pairing key.
 */

import { CLEANUP_PROVIDERS, type SttEnhancementProvider } from '@ferretry/protocol';
import type { DaemonFetch } from '../runtime-models.ts';

export type SpeedupKeyProvider = SttEnhancementProvider;

/** What the settings screen may know about a saved key: that it exists, and how it ends. */
export type SpeedupKeyStatus =
  | { readonly kind: 'none' }
  | { readonly kind: 'saved'; readonly endsWith: string }
  | { readonly kind: 'unreadable'; readonly message: string };

/** The outcome of spending a key: no key here, a key this browser can no longer open, or the reply. */
export type SpeedupKeySend =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'response'; readonly response: Response };

export interface SpeedupKeyRequest {
  /** Which of the provider's two endpoints: chat completions, or the free model list a Test reads. */
  readonly endpoint: 'chat' | 'models';
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/** Where encrypted keys live. A port so the vault never knows it is IndexedDB. */
export interface SpeedupKeyRecords {
  get(slot: string): Promise<unknown>;
  put(slot: string, value: unknown): Promise<void>;
  delete(slot: string): Promise<void>;
}

/** The slice of `SubtleCrypto` the vault uses. */
export type SpeedupKeyCrypto = Pick<SubtleCrypto, 'generateKey' | 'encrypt' | 'decrypt'>;

/** A provider key is a header value: printable ASCII with no spaces, of a plausible length. */
const KEY_SHAPE = /^[\x21-\x7e]{8,512}$/u;

export const SPEEDUP_KEY_SHAPE_SENTENCE =
  'That does not look like an API key: paste the whole key, with no spaces, as the provider shows it.';

/** A key the vault refuses to keep, said so the person can fix it. */
export class SpeedupKeyShapeError extends Error {
  constructor() {
    super(SPEEDUP_KEY_SHAPE_SENTENCE);
    this.name = 'SpeedupKeyShapeError';
  }
}

const WRAPPING_SLOT = 'wrapping-key';
const RECORD_VERSION = 1;

interface SealedKey {
  readonly v: typeof RECORD_VERSION;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly data: ArrayBuffer;
  readonly endsWith: string;
}

const isSealed = (value: unknown): value is SealedKey => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === RECORD_VERSION &&
    record.iv instanceof Uint8Array &&
    record.data instanceof ArrayBuffer &&
    typeof record.endsWith === 'string'
  );
};

const slotOf = (provider: SpeedupKeyProvider): string => `provider:${provider}`;
const additionalData = (provider: SpeedupKeyProvider): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`ferretry-${provider}`);

const UNREADABLE_SENTENCE =
  'This browser can no longer open the key it saved (its site data was cleared or copied). Remove it and save it again.';

export class DeviceSpeedupKeys {
  constructor(
    private readonly records: SpeedupKeyRecords,
    private readonly crypto: SpeedupKeyCrypto,
    /** The app's own network port (`browserFetch`): the provider is not a daemon, so no carrier applies. */
    private readonly network: DaemonFetch,
  ) {}

  async status(provider: SpeedupKeyProvider): Promise<SpeedupKeyStatus> {
    let record: unknown;
    try {
      record = await this.records.get(slotOf(provider));
    } catch {
      return { kind: 'unreadable', message: UNREADABLE_SENTENCE };
    }
    if (record === undefined) return { kind: 'none' };
    return isSealed(record)
      ? { kind: 'saved', endsWith: record.endsWith }
      : { kind: 'unreadable', message: UNREADABLE_SENTENCE };
  }

  /** Keep a key. It is sealed before it is written, and nothing returns it afterwards. */
  async save(provider: SpeedupKeyProvider, value: string): Promise<void> {
    const key = value.trim();
    if (!KEY_SHAPE.test(key)) throw new SpeedupKeyShapeError();
    const wrapping = await this.#wrappingKey();
    const iv = new Uint8Array(12);
    globalThis.crypto.getRandomValues(iv);
    const data = await this.crypto.encrypt(
      { name: 'AES-GCM', iv, additionalData: additionalData(provider) },
      wrapping,
      new TextEncoder().encode(key),
    );
    const sealed: SealedKey = { v: RECORD_VERSION, iv, data, endsWith: key.slice(-2) };
    await this.records.put(slotOf(provider), sealed);
  }

  async remove(provider: SpeedupKeyProvider): Promise<void> {
    await this.records.delete(slotOf(provider));
  }

  /**
   * Spend the key on one request to its provider. The URL comes from the shared provider table, so a
   * Groq key can only ever reach `api.groq.com`. A network failure is thrown as the network threw it.
   */
  async send(provider: SpeedupKeyProvider, request: SpeedupKeyRequest): Promise<SpeedupKeySend> {
    const opened = await this.#open(provider);
    if (opened.kind !== 'opened') return opened;
    const definition = CLEANUP_PROVIDERS[provider];
    const url = request.endpoint === 'chat' ? definition.endpoint : definition.modelsUrl;
    const response = await this.network(url, {
      method: request.endpoint === 'chat' ? 'POST' : 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${opened.key}`,
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      // No cookie, no referrer and no cache entry travel with a third-party call.
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    return { kind: 'response', response };
  }

  async #open(
    provider: SpeedupKeyProvider,
  ): Promise<{ readonly kind: 'opened'; readonly key: string } | { readonly kind: 'missing' | 'unreadable' }> {
    try {
      const record = await this.records.get(slotOf(provider));
      if (record === undefined) return { kind: 'missing' };
      const wrapping = await this.records.get(WRAPPING_SLOT);
      if (!isSealed(record) || !(wrapping instanceof CryptoKey)) return { kind: 'unreadable' };
      const plain = await this.crypto.decrypt(
        { name: 'AES-GCM', iv: record.iv, additionalData: additionalData(provider) },
        wrapping,
        record.data,
      );
      return { kind: 'opened', key: new TextDecoder().decode(plain) };
    } catch {
      return { kind: 'unreadable' };
    }
  }

  /** The one wrapping key, minted non-extractable on first save and reused after. */
  async #wrappingKey(): Promise<CryptoKey> {
    const held = await this.records.get(WRAPPING_SLOT);
    if (held instanceof CryptoKey) return held;
    const minted = (await this.crypto.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ])) as CryptoKey;
    await this.records.put(WRAPPING_SLOT, minted);
    return minted;
  }
}

/** The slice of `IDBFactory` the records use, so a suite can supply one without a browser. */
export interface SpeedupKeyDatabaseFactory {
  open(name: string, version?: number): IDBOpenDBRequest;
}

const DATABASE = 'ferretry-speedup-keys';
const STORE = 'keys';
const VERSION = 1;

const settled = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('the speed-up key store refused a request'));
  });

/**
 * Sealed keys in IndexedDB, opened per call like `IndexedDbDeviceKeyStore`: a held connection would
 * block a future version change, and this is touched once per dictation.
 */
export class IndexedDbSpeedupKeyRecords implements SpeedupKeyRecords {
  constructor(private readonly factory: SpeedupKeyDatabaseFactory | undefined) {}

  async get(slot: string): Promise<unknown> {
    return await this.#run('readonly', store => store.get(slot));
  }

  async put(slot: string, value: unknown): Promise<void> {
    await this.#run('readwrite', store => store.put(value, slot));
  }

  async delete(slot: string): Promise<void> {
    await this.#run('readwrite', store => store.delete(slot));
  }

  async #run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const factory = this.factory;
    if (factory === undefined) throw new Error('this browser has no IndexedDB, so it cannot keep a key');
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
