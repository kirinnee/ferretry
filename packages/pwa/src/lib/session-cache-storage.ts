/**
 * The session cache's storage in a browser: one IndexedDB object store of plain records, keyed by the
 * cache's own key strings (`session-cache.ts` owns what is in them and every bound on them).
 *
 * Its own database, apart from the pairing store and the release keeper's, so emptying it can never
 * touch a pairing or a device key. The database is opened once and reused; a failed open is retried
 * by the next call rather than remembered.
 */

import type { SessionCacheBackend } from './session-cache.ts';

export const SESSION_CACHE_DATABASE = 'ferretry-session-cache';
export const SESSION_CACHE_OBJECT_STORE = 'records';

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });

const openDatabase = (factory: IDBFactory): Promise<IDBDatabase> =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(SESSION_CACHE_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SESSION_CACHE_OBJECT_STORE))
        request.result.createObjectStore(SESSION_CACHE_OBJECT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the session cache'));
    request.onblocked = () => reject(new Error('the session cache upgrade is blocked'));
  });

export class IndexedDbSessionCacheBackend implements SessionCacheBackend {
  readonly #factory: IDBFactory;
  #database: Promise<IDBDatabase> | null = null;

  constructor(factory: IDBFactory) {
    this.#factory = factory;
  }

  async get(key: string): Promise<unknown> {
    return await this.#read(store => store.get(key));
  }

  async keys(): Promise<readonly string[]> {
    const keys = await this.#read(store => store.getAllKeys());
    return keys.filter((key): key is string => typeof key === 'string');
  }

  async put(key: string, value: unknown): Promise<void> {
    await this.#write(store => store.put(value, key));
  }

  async delete(key: string): Promise<void> {
    await this.#write(store => store.delete(key));
  }

  async clear(): Promise<void> {
    await this.#write(store => store.clear());
  }

  async #read<T>(request: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const transaction = (await this.#open()).transaction(SESSION_CACHE_OBJECT_STORE, 'readonly');
    return await requestResult(request(transaction.objectStore(SESSION_CACHE_OBJECT_STORE)));
  }

  async #write(request: (store: IDBObjectStore) => IDBRequest): Promise<void> {
    const transaction = (await this.#open()).transaction(SESSION_CACHE_OBJECT_STORE, 'readwrite');
    request(transaction.objectStore(SESSION_CACHE_OBJECT_STORE));
    await transactionComplete(transaction);
  }

  #open(): Promise<IDBDatabase> {
    if (this.#database !== null) return this.#database;
    const opening = openDatabase(this.#factory);
    this.#database = opening;
    opening.catch(() => {
      if (this.#database === opening) this.#database = null;
    });
    return opening;
  }
}

/** Where `indexedDB` is looked up. Injected so a test never has to mutate a global. */
export interface SessionCacheStorageSource {
  readonly indexedDB?: unknown;
}

/** The browser's backend, or `null` where IndexedDB is missing or merely reading it throws. */
export const browserSessionCacheBackend = (
  source: SessionCacheStorageSource = globalThis as SessionCacheStorageSource,
): IndexedDbSessionCacheBackend | null => {
  try {
    const factory = source.indexedDB as IDBFactory | undefined;
    return factory && typeof factory.open === 'function' ? new IndexedDbSessionCacheBackend(factory) : null;
  } catch {
    return null;
  }
};
