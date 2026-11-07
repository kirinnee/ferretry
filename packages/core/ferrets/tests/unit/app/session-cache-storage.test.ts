import { describe, it } from 'bun:test';
import should from 'should';

import {
  browserSessionCacheBackend,
  IndexedDbSessionCacheBackend,
  SESSION_CACHE_DATABASE,
  SESSION_CACHE_OBJECT_STORE,
} from '../../src/lib/session-cache-storage.ts';

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
  | 'request-error'
  | 'request-error-without-cause'
  | 'abort'
  | 'abort-without-cause'
  | 'error'
  | 'error-without-cause';

const fakeIndexedDb = (options: { open?: OpenOutcome[]; failure?: Failure; stores?: string[] } = {}) => {
  const values = new Map<PropertyKey, unknown>();
  const stores = new Set(options.stores ?? []);
  const failure = options.failure ?? 'none';
  const opens: { name: string; version: number | undefined }[] = [];
  const transactions: { store: string; mode: string }[] = [];
  const cause = (withCause: boolean) => (withCause ? new DOMException('quota', 'QuotaExceededError') : null);
  const settleRead = <T>(result: T): FakeRequest<T> => {
    const failing = failure === 'request-error' || failure === 'request-error-without-cause';
    const request = fakeRequest(result, failing ? cause(failure === 'request-error') : null);
    queueMicrotask(() => (failing ? request.onerror?.() : request.onsuccess?.()));
    return request;
  };
  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => stores.add(name),
    transaction: (store: string, mode: string) => {
      transactions.push({ store, mode });
      const transaction = {
        error: null as DOMException | null,
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        objectStore: () => {
          const write = (change: () => void) => {
            if (failure === 'none') change();
            transaction.error = cause(!failure.endsWith('without-cause'));
            queueMicrotask(() => {
              if (failure === 'abort' || failure === 'abort-without-cause') transaction.onabort?.();
              else if (failure === 'error' || failure === 'error-without-cause') transaction.onerror?.();
              else transaction.oncomplete?.();
            });
            return fakeRequest(undefined);
          };
          return {
            get: (key: string) => settleRead(values.get(key)),
            getAllKeys: () => settleRead([...values.keys(), 7, Symbol.for('non-string key')] as unknown[]),
            put: (value: unknown, key: string) => write(() => values.set(key, value)),
            delete: (key: string) => write(() => values.delete(key)),
            clear: () => write(() => values.clear()),
          };
        },
      };
      return transaction;
    },
  };
  const outcomes = [...(options.open ?? [])];
  const factory = {
    open: (name?: string, version?: number) => {
      opens.push({ name: name ?? '', version });
      const outcome = outcomes.shift() ?? 'success';
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
  return { factory, stores, values, opens, transactions };
};

describe('IndexedDbSessionCacheBackend', () => {
  it('opens its own database once, creating the record store on upgrade', async () => {
    // Arrange
    const idb = fakeIndexedDb();
    const subject = new IndexedDbSessionCacheBackend(idb.factory);

    // Act
    await subject.get('a');
    await subject.get('b');

    // Assert
    should(idb.opens).eql([{ name: SESSION_CACHE_DATABASE, version: 1 }]);
    should([...idb.stores]).eql([SESSION_CACHE_OBJECT_STORE]);
  });

  it('reuses a record store that already exists', async () => {
    // Arrange
    const idb = fakeIndexedDb({ stores: [SESSION_CACHE_OBJECT_STORE] });
    const subject = new IndexedDbSessionCacheBackend(idb.factory);

    // Act
    const actual = await subject.get('missing');

    // Assert
    should(actual).be.undefined();
    should([...idb.stores]).eql([SESSION_CACHE_OBJECT_STORE]);
  });

  it('puts, gets and deletes a record by its key', async () => {
    // Arrange
    const idb = fakeIndexedDb();
    const subject = new IndexedDbSessionCacheBackend(idb.factory);

    // Act
    await subject.put('k', { n: 1 });
    const stored = await subject.get('k');
    await subject.delete('k');
    const gone = await subject.get('k');

    // Assert
    should(stored).eql({ n: 1 });
    should(gone).be.undefined();
    should(idb.transactions.map(each => each.mode)).eql(['readwrite', 'readonly', 'readwrite', 'readonly']);
    should(idb.transactions.every(each => each.store === SESSION_CACHE_OBJECT_STORE)).be.true();
  });

  it('lists only the string keys', async () => {
    // Arrange
    const idb = fakeIndexedDb();
    const subject = new IndexedDbSessionCacheBackend(idb.factory);
    await subject.put('first', 1);
    await subject.put('second', 2);

    // Act
    const actual = await subject.keys();

    // Assert
    should(actual).eql(['first', 'second']);
  });

  it('clears every record', async () => {
    // Arrange
    const idb = fakeIndexedDb();
    const subject = new IndexedDbSessionCacheBackend(idb.factory);
    await subject.put('first', 1);

    // Act
    await subject.clear();

    // Assert
    should(idb.values.size).equal(0);
  });

  it.each([
    ['request-error', 'quota'],
    ['request-error-without-cause', 'IndexedDB request failed'],
  ] as const)('rejects a read whose request ends in %s', async (failure, message) => {
    const subject = new IndexedDbSessionCacheBackend(fakeIndexedDb({ failure }).factory);
    await should(subject.get('k')).be.rejectedWith(new RegExp(message, 'u'));
    await should(subject.keys()).be.rejectedWith(new RegExp(message, 'u'));
  });

  it.each([
    ['abort', 'quota'],
    ['abort-without-cause', 'IndexedDB transaction aborted'],
    ['error', 'quota'],
    ['error-without-cause', 'IndexedDB transaction failed'],
  ] as const)('rejects a write whose transaction ends in %s', async (failure, message) => {
    const subject = new IndexedDbSessionCacheBackend(fakeIndexedDb({ failure }).factory);
    await should(subject.put('k', 1)).be.rejectedWith(new RegExp(message, 'u'));
    await should(subject.delete('k')).be.rejectedWith(new RegExp(message, 'u'));
    await should(subject.clear()).be.rejectedWith(new RegExp(message, 'u'));
  });

  it.each([
    ['error', 'quota'],
    ['error-without-cause', 'could not open the session cache'],
    ['blocked', 'the session cache upgrade is blocked'],
  ] as const)('rejects when opening ends in %s', async (outcome, message) => {
    const subject = new IndexedDbSessionCacheBackend(fakeIndexedDb({ open: [outcome] }).factory);
    await should(subject.get('k')).be.rejectedWith(new RegExp(message, 'u'));
  });

  it('retries a failed open on the next call rather than remembering the failure', async () => {
    // Arrange
    const idb = fakeIndexedDb({ open: ['blocked'] });
    const subject = new IndexedDbSessionCacheBackend(idb.factory);

    // Act
    const first = subject.put('k', 1);
    await first.catch(() => undefined);
    await subject.put('k', 2);

    // Assert
    should(idb.opens.length).equal(2);
    should(idb.values.get('k')).equal(2);
  });

  it('shares one open between calls that are in flight together', async () => {
    // Arrange
    const idb = fakeIndexedDb();
    const subject = new IndexedDbSessionCacheBackend(idb.factory);

    // Act
    await Promise.all([subject.get('a'), subject.get('b')]);

    // Assert
    should(idb.opens.length).equal(1);
  });
});

describe('browserSessionCacheBackend', () => {
  it('builds a backend over the injected factory', () => {
    const actual = browserSessionCacheBackend({ indexedDB: fakeIndexedDb().factory });
    should(actual).be.instanceOf(IndexedDbSessionCacheBackend);
  });

  it.each([
    ['missing', {}],
    ['without an open function', { indexedDB: {} }],
  ])('is null when IndexedDB is %s', (_name, source) => {
    should(browserSessionCacheBackend(source)).be.null();
  });

  it('is null when merely reading IndexedDB throws', () => {
    const source = {
      get indexedDB(): unknown {
        throw new Error('storage disabled');
      },
    };
    should(browserSessionCacheBackend(source)).be.null();
  });

  it('looks IndexedDB up on the global when given no source', () => {
    const host = globalThis as { indexedDB?: unknown };
    const had = 'indexedDB' in host;
    const previous = host.indexedDB;
    host.indexedDB = fakeIndexedDb().factory;
    try {
      should(browserSessionCacheBackend()).be.instanceOf(IndexedDbSessionCacheBackend);
    } finally {
      if (had) host.indexedDB = previous;
      else delete host.indexedDB;
    }
  });
});
