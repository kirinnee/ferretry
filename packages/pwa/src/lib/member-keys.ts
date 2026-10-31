/**
 * THE KEYS THIS BROWSER HOLDS AS A CATALOG MEMBER, AND WHAT IT KNOWS ABOUT EACH PUBLISHER.
 *
 * A member is a person a publisher shared catalogs with. For EACH publisher this browser makes two keys
 * of its own: a non-extractable Ed25519 MEMBER key that proves it in a member session, and a
 * non-extractable X25519 BOX key whose public half is filed at join (phase 6 wraps content keys to it).
 * They live in their own IndexedDB, `ferretry-member-keys`, apart from the device keys: a member key is
 * never a device key and a pairing never reads this store.
 *
 * ONE RECORD PER PUBLISHER, keyed by the VERIFIED daemon id (`fy_daemon_…`). A key is written only
 * after the publisher answered `joined`; until then the keys live in memory and a failed join leaves
 * nothing behind.
 *
 * A REFUSED KEY IS KEPT. When a publisher refuses the key (`4403`), the record is marked `refused` and
 * the person is asked what to do. Nothing in this module removes a record except `forget`, which only
 * the person's own tap (Forget this catalog, or Leave) calls: a refusal is never a reason to delete
 * the evidence silently.
 */

import type { DaemonCarrier } from '@ferretry/protocol';
import { toBase64Url } from '@ferretry/relay';

/** One subscription's lifecycle in this browser: working, or refused by the publisher. */
type MemberSubscriptionStatus = 'active' | 'refused';

/** Everything this browser keeps for one publisher it joined. */
export interface MemberSubscription {
  /** The VERIFIED daemon id: the publisher's fingerprint, and the key of this record. */
  readonly daemonId: string;
  readonly daemonName: string;
  /** The publisher's own address from the link, tried first. */
  readonly daemonUrl: string;
  /** What the person calls this publisher. Starts as the name the publisher gave itself. */
  readonly ownLabel: string;
  readonly keyId: string;
  readonly memberId: string;
  /** What the owner calls this member ("Alice"). */
  readonly memberLabel: string;
  readonly status: MemberSubscriptionStatus;
  readonly joinedAt: string;
  readonly refusedAt?: string;
  readonly passkeyWindowEndsAt: string;
  readonly unlockDays: number;
  /** The addresses the publisher said it can be reached at, as of the last time it answered. */
  readonly carriers: readonly DaemonCarrier[];
  /** The Ed25519 SPKI, base64url: what the publisher holds of this browser. */
  readonly publicKey: string;
  /** The X25519 public key, base64url. */
  readonly boxKey: string;
  readonly signingKey: CryptoKey;
  readonly boxPrivateKey: CryptoKey;
}

/** The two key pairs a join needs, before anything has been sent. Held in memory until `joined`. */
export interface MintedMemberKeys {
  readonly signingKey: CryptoKey;
  readonly publicKey: string;
  readonly boxPrivateKey: CryptoKey;
  readonly boxKey: string;
}

/** The WebCrypto calls minting needs, so a suite can stand in for a browser that refuses a curve. */
export interface MemberKeyGenerator {
  generateMemberKeys(): Promise<{
    readonly signingKey: CryptoKey;
    readonly publicKeySpki: Uint8Array;
    readonly boxPrivateKey: CryptoKey;
    readonly boxPublicKey: Uint8Array;
  }>;
}

export const UNSUPPORTED_MEMBER_KEY_SENTENCE =
  'This browser cannot make the keys a shared catalog needs (Ed25519 and X25519). Update the browser, or open the link in a different one.';

/** This browser cannot make a member key at all. Final: no retry changes it. */
export class MemberKeyUnsupportedError extends Error {
  constructor() {
    super(UNSUPPORTED_MEMBER_KEY_SENTENCE);
    this.name = 'MemberKeyUnsupportedError';
  }
}

/** The real generator: both keys NON-EXTRACTABLE, public halves exported. */
export const webCryptoMemberKeyGenerator = (subtle: SubtleCrypto = globalThis.crypto.subtle): MemberKeyGenerator => ({
  async generateMemberKeys() {
    const signing = (await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const box = (await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
    return {
      signingKey: signing.privateKey,
      publicKeySpki: new Uint8Array(await subtle.exportKey('spki', signing.publicKey)),
      boxPrivateKey: box.privateKey,
      boxPublicKey: new Uint8Array(await subtle.exportKey('raw', box.publicKey)),
    };
  },
});

/** New member keys for ONE publisher, or the one sentence that says this browser cannot. */
export async function mintMemberKeys(generator: MemberKeyGenerator): Promise<MintedMemberKeys> {
  let generated: Awaited<ReturnType<MemberKeyGenerator['generateMemberKeys']>>;
  try {
    generated = await generator.generateMemberKeys();
  } catch {
    throw new MemberKeyUnsupportedError();
  }
  return {
    signingKey: generated.signingKey,
    publicKey: toBase64Url(generated.publicKeySpki),
    boxPrivateKey: generated.boxPrivateKey,
    boxKey: toBase64Url(generated.boxPublicKey),
  };
}

/** Where member subscriptions live. A port so nothing above it knows it is IndexedDB. */
export interface MemberKeyStore {
  list(): Promise<readonly MemberSubscription[]>;
  load(daemonId: string): Promise<MemberSubscription | undefined>;
  /** Written ONLY after the publisher answered `joined`. */
  save(subscription: MemberSubscription): Promise<void>;
  /** Keeps the record and says the publisher refused the key. `false` when there is no such record. */
  markRefused(daemonId: string, at: string): Promise<boolean>;
  /** Takes the refused mark off: the publisher answered this key again. The key itself is untouched. */
  clearRefused(daemonId: string): Promise<boolean>;
  rename(daemonId: string, ownLabel: string): Promise<boolean>;
  /** The ONLY removal: the person's own tap. */
  forget(daemonId: string): Promise<void>;
}

/** The slice of `IDBFactory` this store uses, so a suite can supply one without a browser. */
export interface MemberKeyDatabaseFactory {
  open(name: string, version?: number): IDBOpenDBRequest;
}

const DATABASE = 'ferretry-member-keys';
const STORE = 'subscriptions';
const VERSION = 1;

const settled = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('the member key store refused a request'));
  });

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** A stored value read back as a subscription, or `undefined` when it is not one (never a half-read record). */
export const readSubscription = (value: unknown): MemberSubscription | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.status !== 'active' && record.status !== 'refused') return undefined;
  if (!(record.signingKey instanceof CryptoKey) || !(record.boxPrivateKey instanceof CryptoKey)) return undefined;
  const texts = [
    record.daemonId,
    record.daemonName,
    record.daemonUrl,
    record.ownLabel,
    record.keyId,
    record.memberId,
    record.memberLabel,
    record.joinedAt,
    record.passkeyWindowEndsAt,
    record.publicKey,
    record.boxKey,
  ];
  if (!texts.every(isText)) return undefined;
  if (typeof record.unlockDays !== 'number' || !Array.isArray(record.carriers)) return undefined;
  return record as unknown as MemberSubscription;
};

/** Member subscriptions in IndexedDB, opened per call like the device key store. */
export class IndexedDbMemberKeyStore implements MemberKeyStore {
  constructor(private readonly factory: MemberKeyDatabaseFactory | undefined = globalThis.indexedDB) {}

  async list(): Promise<readonly MemberSubscription[]> {
    const values = await this.#run('readonly', store => store.getAll());
    return values.map(readSubscription).filter((one): one is MemberSubscription => one !== undefined);
  }

  async load(daemonId: string): Promise<MemberSubscription | undefined> {
    return readSubscription(await this.#run('readonly', store => store.get(daemonId)));
  }

  async save(subscription: MemberSubscription): Promise<void> {
    await this.#run('readwrite', store => store.put(subscription, subscription.daemonId));
  }

  async markRefused(daemonId: string, at: string): Promise<boolean> {
    const found = await this.load(daemonId);
    if (found === undefined) return false;
    await this.save({ ...found, status: 'refused', refusedAt: at });
    return true;
  }

  async clearRefused(daemonId: string): Promise<boolean> {
    const found = await this.load(daemonId);
    if (found === undefined) return false;
    const { refusedAt: _refusedAt, ...rest } = found;
    await this.save({ ...rest, status: 'active' });
    return true;
  }

  async rename(daemonId: string, ownLabel: string): Promise<boolean> {
    const found = await this.load(daemonId);
    if (found === undefined) return false;
    await this.save({ ...found, ownLabel });
    return true;
  }

  async forget(daemonId: string): Promise<void> {
    await this.#run('readwrite', store => store.delete(daemonId));
  }

  async #run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const factory = this.factory;
    if (factory === undefined) throw new Error('this browser has no IndexedDB, so it cannot keep a member key');
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

/** The first 20 characters of a fingerprint after `fy_daemon_` (120 bits), the part a person can compare. */
export const fingerprintHead = (daemonId: string): string => daemonId.replace(/^fy_daemon_/u, '').slice(0, 20);
