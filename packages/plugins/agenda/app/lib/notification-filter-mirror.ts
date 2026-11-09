/**
 * THE SERVICE WORKER'S WINDOW INTO THIS DEVICE'S NOTIFICATION FILTER (S6).
 *
 * `DeviceNotificationFilterStore` (`notification-filter.ts`) is synchronous and backed by `localStorage`, which a
 * service worker cannot read. IndexedDB is the one storage both a page and its worker can reach, so Agenda writes the
 * v2 FILTER DOCUMENT (`@ferretry/kernel/contract/notification-filter`) there at app boot and on every change of its
 * settings, and the shell's signed worker reads it back and calls the kernel's `shouldShowPush` over it.
 *
 * MIRROR, NOT SOURCE OF TRUTH. The page always reads and writes `localStorage` directly through the store; this is a
 * one-way shadow copy. A worker that finds an absent, stale, unreadable or over-bound document shows everything, the same
 * safe default an unconfigured device starts from: a worker can never show LESS than an unconfigured device would. The
 * worker reads; this file only writes, and the document's names, shape and encoding (the JSON TEXT) are the kernel's.
 *
 * BEST EFFORT. A write that fails leaves the worker on whatever it last saw, or on the default, and never breaks the
 * setting the person just changed, which stays correct in `localStorage`. Nothing here throws past its own boundary.
 */

import {
  NOTIFICATION_FILTER_DB,
  NOTIFICATION_FILTER_DB_VERSION,
  NOTIFICATION_FILTER_KEY,
  NOTIFICATION_FILTER_STORE,
  type NotificationFilterDocument,
} from '@ferretry/kernel/contract/notification-filter';

const transactionComplete = (transaction: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });

const openMirrorDatabase = (factory: IDBFactory): Promise<IDBDatabase> =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(NOTIFICATION_FILTER_DB, NOTIFICATION_FILTER_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(NOTIFICATION_FILTER_STORE)) {
        request.result.createObjectStore(NOTIFICATION_FILTER_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the notification filter mirror'));
    request.onblocked = () => reject(new Error('the notification filter mirror upgrade is blocked'));
  });

/** What `DeviceNotificationFilterStore` writes through at boot and on every `set()`. */
export interface NotificationFilterMirrorWriter {
  write(document: NotificationFilterDocument): Promise<void>;
}

/** The real IndexedDB-backed writer: the document's JSON text, at the kernel's database, store and key. */
export class IndexedDbNotificationFilterMirror implements NotificationFilterMirrorWriter {
  constructor(private readonly factory: IDBFactory) {}

  /** Overwrites the document in one transaction. Throws on failure; callers decide how to treat that. */
  async write(document: NotificationFilterDocument): Promise<void> {
    const database = await openMirrorDatabase(this.factory);
    try {
      const transaction = database.transaction(NOTIFICATION_FILTER_STORE, 'readwrite');
      transaction.objectStore(NOTIFICATION_FILTER_STORE).put(JSON.stringify(document), NOTIFICATION_FILTER_KEY);
      await transactionComplete(transaction);
    } finally {
      // Every write opens its own connection; one left open would block a later version bump of the database, and
      // the worker's open would then wait on it and fall back to showing everything.
      database.close();
    }
  }
}

/** Where `indexedDB` is looked up. Injected so a test never has to mutate a global. */
export interface NotificationFilterMirrorSource {
  readonly indexedDB?: unknown;
}

/**
 * Resolves the page's writer onto the mirror, treating absence or denial as an ordinary condition. `indexedDB` can be
 * missing in a locked-down browser mode, and merely reading the property throws in some of them.
 */
export const browserNotificationFilterMirror = (
  source: NotificationFilterMirrorSource = globalThis as NotificationFilterMirrorSource,
): IndexedDbNotificationFilterMirror | null => {
  try {
    const factory = source.indexedDB as IDBFactory | undefined;
    return factory && typeof factory.open === 'function' ? new IndexedDbNotificationFilterMirror(factory) : null;
  } catch {
    return null;
  }
};
