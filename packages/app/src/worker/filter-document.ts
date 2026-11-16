/**
 * THE WORKER'S READ OF THIS DEVICE'S NOTIFICATION FILTER (S6): the one document Agenda writes
 * (`@ferretry/kernel/contract/notification-filter`) and this worker only EVALUATES, so a push that reaches a closed app is
 * held to the same muted machines, hidden kinds and quiet hours the open app is.
 *
 * NOTHING THE WORKER STORES IS TRUSTED: any page on this origin can write IndexedDB. So the stored value is handed to the
 * kernel's total reader, which parses it strictly and bounded and answers the DEFAULT (everything shown) for anything it
 * does not recognise — a worker can never show LESS than an unconfigured device. A page that writes a document hiding
 * everything cannot make a push show nothing either: a hidden push is still shown, as the quiet line.
 *
 * BEST EFFORT AND NEVER REJECTING: a database that cannot be opened (a locked-down browser), a store that was never
 * created and a read that fails all answer the default. Called inside `event.waitUntil`, so it may take as long as
 * IndexedDB needs.
 */

import {
  NOTIFICATION_FILTER_DB,
  NOTIFICATION_FILTER_DB_VERSION,
  NOTIFICATION_FILTER_KEY,
  NOTIFICATION_FILTER_STORE,
  type NotificationFilterDocument,
  readNotificationFilterDocument,
} from '@ferretry/kernel/contract/notification-filter';

const openDatabase = (factory: IDBFactory): Promise<IDBDatabase> =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(NOTIFICATION_FILTER_DB, NOTIFICATION_FILTER_DB_VERSION);
    // Agenda's writer creates the store; a worker that opens the database first creates the same one, empty.
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(NOTIFICATION_FILTER_STORE)) {
        request.result.createObjectStore(NOTIFICATION_FILTER_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the notification filter'));
    request.onblocked = () => reject(new Error('the notification filter is blocked'));
  });

const stored = (database: IDBDatabase): Promise<unknown> =>
  new Promise<unknown>((resolve, reject) => {
    const request = database
      .transaction(NOTIFICATION_FILTER_STORE, 'readonly')
      .objectStore(NOTIFICATION_FILTER_STORE)
      .get(NOTIFICATION_FILTER_KEY);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not read the notification filter'));
  });

/** The document this device holds, else the default (everything shown). Never rejects. */
export async function readFilterDocument(factory: IDBFactory | undefined): Promise<NotificationFilterDocument> {
  let database: IDBDatabase | undefined;
  try {
    if (factory === undefined) return readNotificationFilterDocument(undefined);
    database = await openDatabase(factory);
    return readNotificationFilterDocument(await stored(database));
  } catch {
    return readNotificationFilterDocument(undefined);
  } finally {
    try {
      database?.close();
    } catch {
      // closing is a courtesy
    }
  }
}
