import { describe, it } from 'bun:test';
import should from 'should';

import {
  NOTIFICATION_FILTER_DB,
  NOTIFICATION_FILTER_DB_VERSION,
  NOTIFICATION_FILTER_KEY,
  NOTIFICATION_FILTER_STORE,
  type NotificationFilterDocument,
  readNotificationFilterDocument,
} from '@ferretry/kernel/contract/notification-filter';
import { filterDocumentOf } from '../../../app/lib/notification-filter.ts';
import {
  browserNotificationFilterMirror,
  IndexedDbNotificationFilterMirror,
} from '../../../app/lib/notification-filter-mirror.ts';

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
type Failure = 'none' | 'abort' | 'abort-without-cause' | 'error' | 'error-without-cause';

/** The same fake-IndexedDB idiom `release-storage.test.ts` uses: no browser runs this test file. */
const fakeIndexedDb = (options: { open?: OpenOutcome; failure?: Failure; stores?: string[] } = {}) => {
  const puts: [string, unknown][] = [];
  const opened: [string, number][] = [];
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
          put: (value: unknown, key: string) => {
            if (failure === 'none') puts.push([key, value]);
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
    open: (name: string, version: number) => {
      opened.push([name, version]);
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
  return { factory, stores, puts, opened };
};

const CUSTOM: NotificationFilterDocument = filterDocumentOf({
  categories: { 'needs-you': true, finished: false, failed: true, 'new-device': false },
  quietHours: { enabled: true, startMinute: 60, endMinute: 120 },
  machines: { 'daemon-a': false },
});

describe('IndexedDbNotificationFilterMirror', () => {
  it('writes the document as JSON text at the kernel database, store and key, creating the store once', async () => {
    const idb = fakeIndexedDb();
    const subject = new IndexedDbNotificationFilterMirror(idb.factory);

    await subject.write(CUSTOM);

    should([...idb.stores]).eql([NOTIFICATION_FILTER_STORE]);
    should(idb.opened).eql([[NOTIFICATION_FILTER_DB, NOTIFICATION_FILTER_DB_VERSION]]);
    should(idb.puts).eql([[NOTIFICATION_FILTER_KEY, JSON.stringify(CUSTOM)]]);
    // What the worker reads back through the kernel is exactly what Agenda wrote.
    should(readNotificationFilterDocument(idb.puts[0]?.[1])).eql(CUSTOM);
  });

  it('reuses a store that already exists', async () => {
    const idb = fakeIndexedDb({ stores: [NOTIFICATION_FILTER_STORE] });
    await new IndexedDbNotificationFilterMirror(idb.factory).write(CUSTOM);
    should(idb.puts).have.length(1);
  });

  it.each([
    ['error', 'quota'],
    ['error-without-cause', 'could not open the notification filter mirror'],
    ['blocked', 'the notification filter mirror upgrade is blocked'],
  ] as const)('rejects when opening ends in %s', async (open, message) => {
    const subject = new IndexedDbNotificationFilterMirror(fakeIndexedDb({ open }).factory);
    await should(subject.write(CUSTOM)).be.rejectedWith(new RegExp(message, 'u'));
  });

  it.each([
    ['abort', 'quota'],
    ['abort-without-cause', 'IndexedDB transaction aborted'],
    ['error', 'quota'],
    ['error-without-cause', 'IndexedDB transaction failed'],
  ] as const)('rejects a write whose transaction ends in %s', async (failure, message) => {
    const subject = new IndexedDbNotificationFilterMirror(fakeIndexedDb({ failure }).factory);
    await should(subject.write(CUSTOM)).be.rejectedWith(new RegExp(message, 'u'));
  });
});

describe('browserNotificationFilterMirror', () => {
  it('resolves a usable factory into a real mirror', async () => {
    const idb = fakeIndexedDb();
    const mirror = browserNotificationFilterMirror({ indexedDB: idb.factory });

    should(mirror).not.be.null();
    await mirror?.write(CUSTOM);
    should(idb.puts).have.length(1);
  });

  it('answers null for an absent indexedDB, a non-object value, or one denied to read', () => {
    should(browserNotificationFilterMirror({})).be.null();
    should(browserNotificationFilterMirror({ indexedDB: 'not a factory' })).be.null();
    should(
      browserNotificationFilterMirror({
        get indexedDB(): unknown {
          throw new Error('denied');
        },
      }),
    ).be.null();
  });
});
