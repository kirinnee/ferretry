/**
 * The outbox's storage in a browser: one IndexedDB object store of entries keyed by message id.
 *
 * Its own database, apart from the session cache, so a cache that is emptied (or evicted) can never take a
 * message the person typed and has not yet sent with it. The database is opened once and reused; a failed
 * open is retried by the next call rather than remembered.
 */

import type { OutboxBackend, OutboxEntry } from './send-outbox.ts';

export const OUTBOX_DATABASE = 'ferretry-outbox';
export const OUTBOX_OBJECT_STORE = 'entries';

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
    const request = factory.open(OUTBOX_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OUTBOX_OBJECT_STORE))
        request.result.createObjectStore(OUTBOX_OBJECT_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the outbox'));
    request.onblocked = () => reject(new Error('the outbox upgrade is blocked'));
  });

export class IndexedDbOutboxBackend implements OutboxBackend {
  readonly #factory: IDBFactory;
  #database: Promise<IDBDatabase> | null = null;

  constructor(factory: IDBFactory) {
    this.#factory = factory;
  }

  async all(): Promise<readonly OutboxEntry[]> {
    const transaction = (await this.#open()).transaction(OUTBOX_OBJECT_STORE, 'readonly');
    const rows = await requestResult(transaction.objectStore(OUTBOX_OBJECT_STORE).getAll());
    return rows as OutboxEntry[];
  }

  async put(entry: OutboxEntry): Promise<void> {
    const transaction = (await this.#open()).transaction(OUTBOX_OBJECT_STORE, 'readwrite');
    transaction.objectStore(OUTBOX_OBJECT_STORE).put(entry);
    await transactionComplete(transaction);
  }

  async delete(id: string): Promise<void> {
    const transaction = (await this.#open()).transaction(OUTBOX_OBJECT_STORE, 'readwrite');
    transaction.objectStore(OUTBOX_OBJECT_STORE).delete(id);
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

export interface OutboxStorageSource {
  readonly indexedDB?: unknown;
}

/** The browser's backend, or `null` where IndexedDB is missing or merely reading it throws. */
export const browserOutboxBackend = (
  source: OutboxStorageSource = globalThis as OutboxStorageSource,
): IndexedDbOutboxBackend | null => {
  try {
    const factory = source.indexedDB as IDBFactory | undefined;
    return factory && typeof factory.open === 'function' ? new IndexedDbOutboxBackend(factory) : null;
  } catch {
    return null;
  }
};
