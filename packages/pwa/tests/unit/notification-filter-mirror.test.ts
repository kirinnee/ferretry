import { describe, it } from 'bun:test';
import should from 'should';

import {
  DEFAULT_NOTIFICATION_FILTER_PREFERENCES,
  type DeviceNotificationFilterPreferences,
} from '../../src/lib/notification-filter.ts';
import {
  browserNotificationFilterMirror,
  IndexedDbNotificationFilterMirror,
  readMirroredNotificationFilter,
} from '../../src/lib/notification-filter-mirror.ts';

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

/** The same fake-IndexedDB idiom `release-storage.test.ts` uses: no browser runs this test file. */
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

const CUSTOM: DeviceNotificationFilterPreferences = {
  categories: { 'needs-you': true, finished: false, failed: true, 'new-device': false },
  quietHours: { enabled: true, startMinute: 60, endMinute: 120 },
  machines: { 'daemon-a': false },
};

describe('IndexedDbNotificationFilterMirror', () => {
  it('writes and reads back the mirrored record, creating its store once', async () => {
    const idb = fakeIndexedDb();
    const subject = new IndexedDbNotificationFilterMirror(idb.factory);

    await subject.write(CUSTOM);
    const read = await subject.read();

    should(read).eql(CUSTOM);
    should([...idb.stores]).eql(['mirror']);
  });

  it('reuses a store that already exists', async () => {
    const subject = new IndexedDbNotificationFilterMirror(fakeIndexedDb({ stores: ['mirror'] }).factory);
    await should(subject.read()).be.rejected();
  });

  it('rejects a read of a mirror nothing has ever written to', async () => {
    const subject = new IndexedDbNotificationFilterMirror(fakeIndexedDb().factory);
    await should(subject.read()).be.rejectedWith(/no notification filter has been mirrored/u);
  });

  it.each([
    ['error', 'quota'],
    ['error-without-cause', 'could not open the notification filter mirror'],
    ['blocked', 'the notification filter mirror upgrade is blocked'],
  ] as const)('rejects when opening ends in %s', async (open, message) => {
    const subject = new IndexedDbNotificationFilterMirror(fakeIndexedDb({ open }).factory);
    await should(subject.read()).be.rejectedWith(new RegExp(message, 'u'));
    await should(subject.write(CUSTOM)).be.rejectedWith(new RegExp(message, 'u'));
  });

  it.each([
    ['get-error', 'quota'],
    ['get-error-without-cause', 'IndexedDB request failed'],
  ] as const)('rejects a read whose fetch ends in %s', async (failure, message) => {
    const subject = new IndexedDbNotificationFilterMirror(fakeIndexedDb({ failure }).factory);
    await should(subject.read()).be.rejectedWith(new RegExp(message, 'u'));
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

describe('readMirroredNotificationFilter', () => {
  it('answers the mirrored record when one was written', async () => {
    const idb = fakeIndexedDb();
    await new IndexedDbNotificationFilterMirror(idb.factory).write(CUSTOM);

    should(await readMirroredNotificationFilter(idb.factory)).eql(CUSTOM);
  });

  it('falls back to the exact defaults a page with no stored preference would use, on any failure', async () => {
    should(await readMirroredNotificationFilter(fakeIndexedDb().factory)).eql(DEFAULT_NOTIFICATION_FILTER_PREFERENCES);
    should(await readMirroredNotificationFilter(fakeIndexedDb({ open: 'error' }).factory)).eql(
      DEFAULT_NOTIFICATION_FILTER_PREFERENCES,
    );
  });
});

describe('browserNotificationFilterMirror', () => {
  it('resolves a usable factory into a real mirror', async () => {
    const idb = fakeIndexedDb();
    const mirror = browserNotificationFilterMirror({ indexedDB: idb.factory });

    should(mirror).not.be.null();
    await mirror?.write(CUSTOM);
    should(await mirror?.read()).eql(CUSTOM);
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
