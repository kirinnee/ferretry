/**
 * THE SERVICE WORKER'S WINDOW INTO THIS DEVICE'S NOTIFICATION FILTER.
 *
 * `DeviceNotificationFilterStore` (`notification-filter.ts`) is synchronous and backed by
 * `localStorage`, which a service worker cannot read — `ServiceWorkerGlobalScope` has no
 * `localStorage` at all. IndexedDB is the one storage both a page and its worker can reach, so every
 * write the store makes is mirrored here, and the worker's `push` handler reads it back to apply the
 * same `shouldShowNotification` decision a backgrounded or closed app never got the chance to run.
 *
 * MIRROR, NOT SOURCE OF TRUTH. The page always reads and writes `localStorage` directly through the
 * store; this is a one-way shadow copy kept current on every `set()`. A worker that finds a stale or
 * absent mirror — the very first push before anything was ever written, a denied database, a write
 * that lost a race with a push that arrived first — falls back to
 * `DEFAULT_NOTIFICATION_FILTER_PREFERENCES`, the same safe default the page itself starts from:
 * everything on, no quiet hours, no machine muted. A worker can therefore never show LESS than an
 * unconfigured device would.
 *
 * BEST EFFORT, BOTH DIRECTIONS. A write that fails leaves the worker on whatever it last saw, or on
 * defaults — never breaks the setting the reader just changed, which stays correct in `localStorage`
 * regardless. A read that fails answers the same way. Nothing here may ever throw past its own
 * boundary.
 */

import {
  DEFAULT_NOTIFICATION_FILTER_PREFERENCES,
  type DeviceNotificationFilterPreferences,
  parseNotificationFilterPreferences,
} from './notification-filter.ts';

/** Separate from `ferretry-release` (the signed-release keeper's own database) and from any other. */
const MIRROR_DATABASE = 'ferretry-notification-filter';
const MIRROR_OBJECT_STORE = 'mirror';
const MIRROR_KEY = 'preferences';

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

const openMirrorDatabase = (factory: IDBFactory): Promise<IDBDatabase> =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(MIRROR_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(MIRROR_OBJECT_STORE)) {
        request.result.createObjectStore(MIRROR_OBJECT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the notification filter mirror'));
    request.onblocked = () => reject(new Error('the notification filter mirror upgrade is blocked'));
  });

/** What `DeviceNotificationFilterStore` writes through on every `set()`. */
export interface NotificationFilterMirrorWriter {
  write(value: DeviceNotificationFilterPreferences): Promise<void>;
}

/** What the worker's `push` handler reads. Never throws — see the module doc. */
export interface NotificationFilterMirrorReader {
  read(): Promise<DeviceNotificationFilterPreferences>;
}

/**
 * The real IndexedDB-backed mirror, shared by the page (writer) and the worker (reader) because both
 * open the SAME database, object store and key — the only thing that makes this a mirror rather than
 * two unrelated records.
 */
export class IndexedDbNotificationFilterMirror
  implements NotificationFilterMirrorWriter, NotificationFilterMirrorReader
{
  constructor(private readonly factory: IDBFactory) {}

  /**
   * Overwrites the mirrored record in one transaction. Throws on failure; callers decide how to
   * treat that.
   *
   * Wrapped in the SAME `{ version: 1, ... }` envelope `DeviceNotificationFilterStore` writes to
   * `localStorage`, because `parseNotificationFilterPreferences` — the one parser both storage
   * layers share — demands it; omitting it would make every mirrored write unreadable.
   */
  async write(value: DeviceNotificationFilterPreferences): Promise<void> {
    const database = await openMirrorDatabase(this.factory);
    const transaction = database.transaction(MIRROR_OBJECT_STORE, 'readwrite');
    transaction.objectStore(MIRROR_OBJECT_STORE).put(JSON.stringify({ version: 1, ...value }), MIRROR_KEY);
    await transactionComplete(transaction);
  }

  /** Reads the mirrored record raw. Throws on failure, including "nothing has ever been written". */
  async read(): Promise<DeviceNotificationFilterPreferences> {
    const database = await openMirrorDatabase(this.factory);
    const transaction = database.transaction(MIRROR_OBJECT_STORE, 'readonly');
    const raw = await requestResult<unknown>(transaction.objectStore(MIRROR_OBJECT_STORE).get(MIRROR_KEY));
    if (typeof raw !== 'string') throw new Error('no notification filter has been mirrored yet');
    return parseNotificationFilterPreferences(raw);
  }
}

/**
 * The worker's whole contract with this file: read the mirror, or fall back to the exact defaults a
 * page with no stored preference would use. Called from inside `event.waitUntil`, so it is safe for
 * this to take as long as IndexedDB needs — it is never safe for it to reject.
 */
export async function readMirroredNotificationFilter(
  factory: IDBFactory,
): Promise<DeviceNotificationFilterPreferences> {
  try {
    return await new IndexedDbNotificationFilterMirror(factory).read();
  } catch {
    return DEFAULT_NOTIFICATION_FILTER_PREFERENCES;
  }
}

/** Where `indexedDB` is looked up. Injected so a test never has to mutate a global. */
export interface NotificationFilterMirrorSource {
  readonly indexedDB?: unknown;
}

/**
 * Resolves the page's writer onto the mirror, treating absence or denial as an ordinary condition —
 * the same shape `browserControlsStorage` (`controls.ts`) uses for `localStorage`. `indexedDB` can be
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
