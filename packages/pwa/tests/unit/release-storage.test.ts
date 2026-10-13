import { describe, it } from 'bun:test';
import should from 'should';

import type { KeeperState } from '../../src/lib/release-keeper.ts';
import {
  CacheStorageReleaseCaches,
  type CacheStorageLike,
  FetchReleaseNetwork,
  IndexedDbReleaseState,
  type ReleaseFetch,
} from '../../src/lib/release-storage.ts';
import { bytesOf } from '../support/release.ts';

interface FakeRequest<T> {
  result: T;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
  onupgradeneeded: (() => void) | null;
}

const fakeRequest = <T>(result: T, error: DOMException | null = null): FakeRequest<T> => ({
  result,
  error,
  onsuccess: null,
  onerror: null,
  onblocked: null,
  onupgradeneeded: null,
});

type OpenOutcome = 'success' | 'error' | 'error-without-cause' | 'blocked';
type Failure =
  | 'none'
  | 'get-error'
  | 'get-error-without-cause'
  | 'abort'
  | 'abort-without-cause'
  | 'error'
  | 'error-without-cause';

const fakeIndexedDb = (options: { open?: OpenOutcome; failure?: Failure; stores?: string[] } = {}) => {
  const values = new Map<string, unknown>();
  const stores = new Set(options.stores ?? []);
  const failure = options.failure ?? 'none';
  const cause = (withCause: boolean) => (withCause ? new DOMException('quota', 'QuotaExceededError') : null);
  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => stores.add(name),
    transaction: () => {
      const transaction = {
        error: null as DOMException | null,
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        objectStore: () => ({
          get: (key: string) => {
            const failing = failure === 'get-error' || failure === 'get-error-without-cause';
            const request = fakeRequest(values.get(key), failing ? cause(failure === 'get-error') : null);
            queueMicrotask(() => (failing ? request.onerror?.() : request.onsuccess?.()));
            return request;
          },
          put: (value: unknown, key: string) => {
            if (failure === 'none') values.set(key, value);
            transaction.error = cause(!failure.endsWith('without-cause'));
            queueMicrotask(() => {
              if (failure === 'abort' || failure === 'abort-without-cause') transaction.onabort?.();
              else if (failure === 'error' || failure === 'error-without-cause') transaction.onerror?.();
              else transaction.oncomplete?.();
            });
          },
        }),
      };
      return transaction;
    },
  };
  const factory = {
    open: () => {
      const outcome = options.open ?? 'success';
      const request = fakeRequest(database, outcome === 'error' ? cause(true) : null);
      queueMicrotask(() => {
        if (outcome === 'blocked') return request.onblocked?.();
        if (outcome !== 'success') return request.onerror?.();
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, stores };
};

const STATE: KeeperState = {
  active: { manifestBytes: bytesOf('{}'), signatureText: 'unsigned' },
  previous: null,
  endorsements: [],
  lastOutcome: null,
};

describe('IndexedDbReleaseState', () => {
  it('stores and reloads the keeper record, creating its store once', async () => {
    // Arrange
    const idb = fakeIndexedDb();
    const subject = new IndexedDbReleaseState(idb.factory, 'test-release');

    // Act
    const before = await subject.load();
    await subject.save(STATE);
    const after = await subject.load();

    // Assert
    should(before).be.undefined();
    should(after).eql(STATE);
    should([...idb.stores]).eql(['state']);
  });

  it('reuses a store that already exists', async () => {
    const subject = new IndexedDbReleaseState(fakeIndexedDb({ stores: ['state'] }).factory);
    should(await subject.load()).be.undefined();
  });

  it.each([
    ['error', 'quota'],
    ['error-without-cause', 'could not open the release database'],
    ['blocked', 'the release database upgrade is blocked'],
  ] as const)('rejects when opening ends in %s', async (open, message) => {
    const subject = new IndexedDbReleaseState(fakeIndexedDb({ open }).factory);
    await should(subject.load()).be.rejectedWith(new RegExp(message, 'u'));
  });

  it.each([
    ['get-error', 'quota'],
    ['get-error-without-cause', 'IndexedDB request failed'],
  ] as const)('rejects a load whose read ends in %s', async (failure, message) => {
    const subject = new IndexedDbReleaseState(fakeIndexedDb({ failure }).factory);
    await should(subject.load()).be.rejectedWith(new RegExp(message, 'u'));
  });

  it.each([
    ['abort', 'quota'],
    ['abort-without-cause', 'IndexedDB transaction aborted'],
    ['error', 'quota'],
    ['error-without-cause', 'IndexedDB transaction failed'],
  ] as const)('rejects a save whose transaction ends in %s', async (failure, message) => {
    const subject = new IndexedDbReleaseState(fakeIndexedDb({ failure }).factory);
    await should(subject.save(STATE)).be.rejectedWith(new RegExp(message, 'u'));
  });
});

const fakeCacheStorage = () => {
  const caches = new Map<string, Map<string, Response>>();
  const storage: CacheStorageLike = {
    open: async name => {
      const cache = caches.get(name) ?? new Map<string, Response>();
      caches.set(name, cache);
      return {
        put: async (request, response) => {
          cache.set(request, response);
        },
        match: async request => cache.get(request)?.clone(),
      };
    },
    keys: async () => [...caches.keys()],
    delete: async name => caches.delete(name),
  };
  return { storage, caches };
};

describe('CacheStorageReleaseCaches', () => {
  it('puts and reads back bytes alone, lists and removes', async () => {
    // Arrange
    const fake = fakeCacheStorage();
    const subject = new CacheStorageReleaseCaches(fake.storage);

    // Act
    await subject.put('fy-release-1', 'app/index.html', bytesOf('<p>'));
    const stored = await fake.caches.get('fy-release-1')?.get('/app/index.html')?.clone();
    const read = await subject.get('fy-release-1', 'app/index.html');
    const missing = await subject.get('fy-release-1', 'other');
    const names = await subject.names();
    await subject.remove('fy-release-1');

    // Assert
    should(new TextDecoder().decode(read ?? new Uint8Array())).equal('<p>');
    should([...(stored?.headers.keys() ?? ['missing'])].filter(name => name !== 'content-type')).eql([]);
    should(missing).be.null();
    should(names).eql(['fy-release-1']);
    should([...fake.caches.keys()]).eql([]);
    should([...(fake.caches.get('fy-release-1')?.keys() ?? ['/app/index.html'])]).eql(['/app/index.html']);
  });
});

describe('FetchReleaseNetwork', () => {
  const ORIGIN = 'https://ferretry.example';

  const network = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher: ReleaseFetch = async (url, init) => {
      calls.push({ url, init });
      return await respond(url, init);
    };
    return { subject: new FetchReleaseNetwork(fetcher, ORIGIN), calls };
  };

  const served = (body: string, init: ResponseInit, url: string) => {
    const response = new Response(body, init);
    Object.defineProperty(response, 'url', { value: url });
    return response;
  };

  it('fetches this origin with no cache, and answers the body alone', async () => {
    // Arrange
    const { subject, calls } = network(url =>
      served('bytes', { headers: { 'content-type': 'text/javascript', 'content-encoding': 'br' } }, url),
    );

    // Act
    const actual = await subject.get('assets/a.js');

    // Assert
    should(calls).eql([{ url: `${ORIGIN}/assets/a.js`, init: { cache: 'no-store', credentials: 'same-origin' } }]);
    should(new TextDecoder().decode(actual ?? new Uint8Array())).equal('bytes');
  });

  it('follows a same-origin redirect, and accepts a response that reports no URL', async () => {
    const redirected = network(() => served('ok', {}, `${ORIGIN}/app/`));
    const anonymous = network(() => served('ok', {}, ''));
    should(await redirected.subject.get('app/index.html')).not.be.null();
    should(await anonymous.subject.get('app/index.html')).not.be.null();
  });

  it.each([
    ['a non-2xx answer', () => served('nope', { status: 404 }, `${ORIGIN}/x`)],
    ['a redirect off this origin', () => served('evil', {}, 'https://evil.example/x')],
    [
      'a network failure',
      () => {
        throw new TypeError('offline');
      },
    ],
  ])('answers null for %s', async (_name, respond) => {
    should(await network(respond).subject.get('x')).be.null();
  });
});
