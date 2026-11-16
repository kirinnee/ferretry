import { describe, expect, test } from 'bun:test';
import {
  NOTIFICATION_FILTER_DB,
  NOTIFICATION_FILTER_DB_VERSION,
  NOTIFICATION_FILTER_KEY,
  NOTIFICATION_FILTER_STORE,
} from '@ferretry/kernel/contract/notification-filter';
import { readFilterDocument } from '../../../src/worker/filter-document.ts';

const DOCUMENT = {
  version: 2,
  hiddenKinds: ['failed'],
  mutedDaemons: ['abc'],
  quietHours: { enabled: true, startMinute: 60, endMinute: 120 },
};
const DEFAULT = {
  version: 2,
  hiddenKinds: [],
  mutedDaemons: [],
  quietHours: { enabled: false, startMinute: 0, endMinute: 0 },
};

type Outcome = 'ok' | 'open-error' | 'open-error-bare' | 'blocked' | 'get-error' | 'get-error-bare' | 'throws';

/** A fake IndexedDB: the same idiom the keeper's tests use. No browser runs this file. */
function fakeIndexedDb(options: { value?: unknown; outcome?: Outcome; stores?: string[]; closeThrows?: boolean }) {
  const opened: [string, number][] = [];
  const created: string[] = [];
  const reads: [string, string, string][] = [];
  let closed = 0;
  const outcome = options.outcome ?? 'ok';
  const stores = new Set(options.stores ?? []);
  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      stores.add(name);
      created.push(name);
    },
    close: () => {
      closed += 1;
      if (options.closeThrows === true) throw new Error('close failed');
    },
    transaction: (store: string, mode: string) => ({
      objectStore: () => ({
        get: (key: string) => {
          reads.push([store, mode, key]);
          const failing = outcome === 'get-error' || outcome === 'get-error-bare';
          const request: Record<string, unknown> = {
            result: options.value,
            error: outcome === 'get-error' ? new DOMException('read', 'UnknownError') : null,
            onsuccess: null,
            onerror: null,
          };
          queueMicrotask(() => ((failing ? request.onerror : request.onsuccess) as (() => void) | null)?.());
          return request;
        },
      }),
    }),
  };
  const factory = {
    open: (name: string, version: number) => {
      if (outcome === 'throws') throw new Error('indexedDB denied');
      opened.push([name, version]);
      const request: Record<string, unknown> = {
        result: database,
        error: outcome === 'open-error' ? new DOMException('open', 'UnknownError') : null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        if (outcome === 'blocked') return (request.onblocked as () => void)?.();
        if (outcome === 'open-error' || outcome === 'open-error-bare') return (request.onerror as () => void)?.();
        (request.onupgradeneeded as (() => void) | null)?.();
        (request.onsuccess as () => void)?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { factory, opened, created, reads, closed: () => closed };
}

describe('S6 the worker’s read of the device’s notification filter', () => {
  test('reads the document at the kernel’s database, store and key, then closes the database', async () => {
    const idb = fakeIndexedDb({ value: JSON.stringify(DOCUMENT), stores: [NOTIFICATION_FILTER_STORE] });
    expect(await readFilterDocument(idb.factory)).toEqual(DOCUMENT as never);
    expect(idb.opened).toEqual([[NOTIFICATION_FILTER_DB, NOTIFICATION_FILTER_DB_VERSION]]);
    expect(idb.reads).toEqual([[NOTIFICATION_FILTER_STORE, 'readonly', NOTIFICATION_FILTER_KEY]]);
    expect(idb.closed()).toBe(1);
    expect(idb.created).toEqual([]);
  });

  test('a worker that opens the database before Agenda wrote creates the same empty store, and shows everything', async () => {
    const idb = fakeIndexedDb({ value: undefined });
    expect(await readFilterDocument(idb.factory)).toEqual(DEFAULT as never);
    expect(idb.created).toEqual([NOTIFICATION_FILTER_STORE]);
  });

  test('nothing stored is trusted: junk, a record, an old-shaped or over-bound document all read as the default', async () => {
    const junk: unknown[] = [
      'not json',
      { ...DOCUMENT },
      JSON.stringify({ version: 1, categories: { failed: false } }),
      JSON.stringify({ ...DOCUMENT, hiddenKinds: ['Bad Kind'] }),
      JSON.stringify({ ...DOCUMENT, mutedDaemons: Array.from({ length: 201 }, (_, i) => `d${i}`) }),
      JSON.stringify({ ...DOCUMENT, extra: true }),
      JSON.stringify({ ...DOCUMENT, quietHours: { enabled: true, startMinute: -1, endMinute: 5 } }),
      `${JSON.stringify(DOCUMENT)}${' '.repeat(70_000)}`,
      null,
      7,
    ];
    for (const value of junk) {
      expect(await readFilterDocument(fakeIndexedDb({ value, stores: [NOTIFICATION_FILTER_STORE] }).factory)).toEqual(
        DEFAULT as never,
      );
    }
  });

  test('never rejects: no indexedDB, a refused open, a blocked upgrade, a failed read and a throwing factory all read as the default', async () => {
    expect(await readFilterDocument(undefined)).toEqual(DEFAULT as never);
    for (const outcome of [
      'open-error',
      'open-error-bare',
      'blocked',
      'get-error',
      'get-error-bare',
      'throws',
    ] as const) {
      const idb = fakeIndexedDb({ value: JSON.stringify(DOCUMENT), outcome, stores: [NOTIFICATION_FILTER_STORE] });
      expect(await readFilterDocument(idb.factory)).toEqual(DEFAULT as never);
    }
  });

  test('a database that will not close costs nothing', async () => {
    const idb = fakeIndexedDb({
      value: JSON.stringify(DOCUMENT),
      stores: [NOTIFICATION_FILTER_STORE],
      closeThrows: true,
    });
    expect(await readFilterDocument(idb.factory)).toEqual(DOCUMENT as never);
  });
});
