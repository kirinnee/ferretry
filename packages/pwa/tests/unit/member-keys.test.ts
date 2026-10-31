/**
 * The member keys: minted per publisher, non-extractable, kept in IndexedDB, and never removed by a refusal.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  fingerprintHead,
  IndexedDbMemberKeyStore,
  type MemberKeyDatabaseFactory,
  MemberKeyUnsupportedError,
  mintMemberKeys,
  readSubscription,
  UNSUPPORTED_MEMBER_KEY_SENTENCE,
  webCryptoMemberKeyGenerator,
} from '../../src/lib/member-keys.ts';
import { testMemberKeys, testSubscription } from '../support/member-keys.ts';

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

class ScriptedIndexedDb implements MemberKeyDatabaseFactory {
  readonly values = new Map<string, unknown>();
  readonly stores = new Set<string>();
  readonly opened: string[] = [];
  closes = 0;
  failOpen: DOMException | null | undefined;
  failAction: DOMException | null | undefined;

  open(name: string): IDBOpenDBRequest {
    this.opened.push(name);
    if (this.failOpen !== undefined) return fails(this.failOpen) as unknown as IDBOpenDBRequest;
    const database = {
      objectStoreNames: { contains: (store: string) => this.stores.has(store) },
      createObjectStore: (store: string) => {
        this.stores.add(store);
      },
      close: () => {
        this.closes += 1;
      },
      transaction: () => ({
        objectStore: () => ({
          get: (key: string) =>
            this.failAction !== undefined ? fails(this.failAction) : succeeds(this.values.get(key)),
          getAll: () => succeeds([...this.values.values()]),
          put: (value: unknown, key: string) => {
            this.values.set(key, value);
            return succeeds(key);
          },
          delete: (key: string) => {
            this.values.delete(key);
            return succeeds(undefined);
          },
        }),
      }),
    };
    const request = {
      result: database,
      error: null,
      onsuccess: null as (() => void) | null,
      onerror: null,
      onupgradeneeded: null as (() => void) | null,
    };
    queueMicrotask(() => {
      request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

const DAEMON = `fy_daemon_${'A'.repeat(43)}`;

describe('minting member keys', () => {
  it('should make a non-extractable signing key and box key with their public halves as base64url', async () => {
    const keys = await testMemberKeys();
    should(keys.signingKey.extractable).be.false();
    should(keys.boxPrivateKey.extractable).be.false();
    should(keys.publicKey).match(/^[A-Za-z0-9_-]+$/u);
    should(keys.boxKey).match(/^[A-Za-z0-9_-]{43}$/u);
    await should(crypto.subtle.exportKey('pkcs8', keys.signingKey)).be.rejected();
  });

  it('should make different keys for every publisher', async () => {
    const one = await testMemberKeys();
    const two = await testMemberKeys();
    should(one.publicKey).not.equal(two.publicKey);
    should(one.boxKey).not.equal(two.boxKey);
  });

  it('should say, in one sentence, that this browser cannot when it cannot', async () => {
    const reason = await mintMemberKeys({
      generateMemberKeys: async () => {
        throw new Error('no curve');
      },
    }).catch((thrown: unknown) => thrown);
    should(reason).be.instanceof(MemberKeyUnsupportedError);
    should((reason as Error).message).equal(UNSUPPORTED_MEMBER_KEY_SENTENCE);
    should(await webCryptoMemberKeyGenerator().generateMemberKeys()).have.property('boxPublicKey');
  });
});

describe('the member key store', () => {
  it('should save a subscription under its daemon id and find it again with its keys', async () => {
    const factory = new ScriptedIndexedDb();
    const store = new IndexedDbMemberKeyStore(factory);
    const subscription = await testSubscription(DAEMON);
    await store.save(subscription);
    const loaded = await store.load(DAEMON);
    should(loaded?.daemonName).equal('Studio');
    should(loaded?.signingKey).equal(subscription.signingKey);
    should(factory.opened[0]).equal('ferretry-member-keys');
    should(factory.stores.has('subscriptions')).be.true();
    should(factory.closes).be.above(0);
    should((await store.list()).map(one => one.daemonId)).eql([DAEMON]);
  });

  it('should keep a refused subscription and say so, never removing it', async () => {
    const store = new IndexedDbMemberKeyStore(new ScriptedIndexedDb());
    await store.save(await testSubscription(DAEMON));
    should(await store.markRefused(DAEMON, '2026-10-31T11:00:00.000Z')).be.true();
    const kept = await store.load(DAEMON);
    should(kept?.status).equal('refused');
    should(kept?.refusedAt).equal('2026-10-31T11:00:00.000Z');
    should(await store.markRefused('fy_daemon_other', 'x')).be.false();
  });

  it('should take the refused mark off and keep the key', async () => {
    const store = new IndexedDbMemberKeyStore(new ScriptedIndexedDb());
    await store.save(await testSubscription(DAEMON));
    await store.markRefused(DAEMON, '2026-10-31T11:00:00.000Z');
    should(await store.clearRefused(DAEMON)).be.true();
    const back = await store.load(DAEMON);
    should(back?.status).equal('active');
    should(back?.refusedAt).be.undefined();
    should(await store.clearRefused('fy_daemon_other')).be.false();
  });

  it('should relabel a publisher and report an unknown one', async () => {
    const store = new IndexedDbMemberKeyStore(new ScriptedIndexedDb());
    await store.save(await testSubscription(DAEMON));
    should(await store.rename(DAEMON, 'Work')).be.true();
    should((await store.load(DAEMON))?.ownLabel).equal('Work');
    should(await store.rename('fy_daemon_other', 'x')).be.false();
  });

  it('should forget only when asked', async () => {
    const store = new IndexedDbMemberKeyStore(new ScriptedIndexedDb());
    await store.save(await testSubscription(DAEMON));
    await store.forget(DAEMON);
    should(await store.load(DAEMON)).be.undefined();
  });

  it('should ignore a stored value that is not a whole subscription', async () => {
    const factory = new ScriptedIndexedDb();
    const store = new IndexedDbMemberKeyStore(factory);
    factory.values.set('a', 'nope');
    factory.values.set('b', { status: 'active' });
    should(await store.list()).eql([]);
    should(await store.load('a')).be.undefined();
    const good = await testSubscription(DAEMON);
    should(readSubscription({ ...good, status: 'weird' })).be.undefined();
    should(readSubscription({ ...good, signingKey: 'plain' })).be.undefined();
    should(readSubscription({ ...good, unlockDays: '30' })).be.undefined();
    should(readSubscription({ ...good, keyId: '' })).be.undefined();
    should(readSubscription(null)).be.undefined();
    should(readSubscription(good)).equal(good);
  });

  it('should report a browser with no IndexedDB, and a failing one, plainly', async () => {
    await should(new IndexedDbMemberKeyStore(undefined).list()).be.rejectedWith(/no IndexedDB/u);
    const factory = new ScriptedIndexedDb();
    factory.failOpen = null;
    await should(new IndexedDbMemberKeyStore(factory).list()).be.rejectedWith(/refused a request/u);
    const broken = new ScriptedIndexedDb();
    broken.failAction = new DOMException('quota', 'QuotaExceededError');
    await should(new IndexedDbMemberKeyStore(broken).load(DAEMON)).be.rejected();
    should(broken.closes).equal(1);
  });
});

describe('the fingerprint a person compares', () => {
  it('should be the first 20 characters after fy_daemon_', () => {
    should(fingerprintHead(`fy_daemon_${'abcdefghij'.repeat(5)}`)).equal('abcdefghijabcdefghij');
  });
});
