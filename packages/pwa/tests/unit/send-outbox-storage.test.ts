import { describe, expect, test } from 'bun:test';
import {
  browserOutboxBackend,
  IndexedDbOutboxBackend,
  OUTBOX_DATABASE,
  OUTBOX_OBJECT_STORE,
} from '../../src/lib/send-outbox-storage.ts';
import type { OutboxEntry } from '../../src/lib/send-outbox.ts';

const entry = (id: string): OutboxEntry => ({
  id,
  daemonId: 'd',
  sessionId: 's',
  message: id,
  attachmentIds: [],
  files: [],
  now: false,
  createdAt: '2026-10-30T10:00:00.000Z',
  seq: 1,
});

/** A just-enough IndexedDB: one object store, requests that answer on a microtask. */
const fakeFactory = (options: { open?: 'error' | 'blocked' | 'ok'; abort?: boolean; requestError?: boolean } = {}) => {
  const rows = new Map<string, unknown>();
  const stores = new Set<string>();
  const opened: string[] = [];
  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => stores.add(name),
    transaction: () => {
      const transaction: Record<string, unknown> = {
        objectStore: () => ({
          getAll: () => {
            const request: Record<string, unknown> = { result: [...rows.values()], error: null };
            queueMicrotask(() => {
              if (options.requestError) {
                request.error = new Error('read failed');
                (request.onerror as () => void)();
              } else (request.onsuccess as () => void)();
            });
            return request;
          },
          put: (value: { id: string }) => rows.set(value.id, value),
          delete: (id: string) => rows.delete(id),
        }),
      };
      queueMicrotask(() => {
        if (options.abort) {
          transaction.error = new Error('aborted');
          (transaction.onabort as () => void)();
        } else (transaction.oncomplete as (() => void) | undefined)?.();
      });
      return transaction;
    },
  };
  const factory = {
    open: (name: string, version: number) => {
      opened.push(`${name}@${version}`);
      const request: Record<string, unknown> = { result: database, error: null };
      queueMicrotask(() => {
        if (options.open === 'blocked') (request.onblocked as () => void)();
        else if (options.open === 'error') {
          request.error = new Error('denied');
          (request.onerror as () => void)();
        } else {
          (request.onupgradeneeded as () => void)();
          (request.onupgradeneeded as () => void)();
          (request.onsuccess as () => void)();
        }
      });
      return request;
    },
  };
  return { factory: factory as unknown as IDBFactory, rows, stores, opened };
};

describe('IndexedDbOutboxBackend', () => {
  test('keeps entries by id in its own database and gives them back after a reload', async () => {
    const fake = fakeFactory();
    const backend = new IndexedDbOutboxBackend(fake.factory);
    await backend.put(entry('a'));
    await backend.put(entry('b'));
    await backend.delete('a');
    expect((await backend.all()).map(item => item.id)).toEqual(['b']);
    expect(fake.opened).toEqual([`${OUTBOX_DATABASE}@1`]);
    expect([...fake.stores]).toEqual([OUTBOX_OBJECT_STORE]);
    const reloaded = new IndexedDbOutboxBackend(fake.factory);
    expect((await reloaded.all()).map(item => item.id)).toEqual(['b']);
  });

  test('a failed or blocked open is retried by the next call, not remembered', async () => {
    for (const open of ['error', 'blocked'] as const) {
      const fake = fakeFactory({ open });
      const backend = new IndexedDbOutboxBackend(fake.factory);
      await expect(backend.all()).rejects.toBeInstanceOf(Error);
      await expect(backend.all()).rejects.toBeInstanceOf(Error);
      expect(fake.opened).toHaveLength(2);
    }
  });

  test('a failed read or an aborted write rejects', async () => {
    await expect(new IndexedDbOutboxBackend(fakeFactory({ requestError: true }).factory).all()).rejects.toThrow(
      'read failed',
    );
    await expect(new IndexedDbOutboxBackend(fakeFactory({ abort: true }).factory).put(entry('a'))).rejects.toThrow(
      'aborted',
    );
  });
});

describe('browserOutboxBackend', () => {
  test('is the browser’s IndexedDB, or null where there is none or reading it throws', () => {
    expect(browserOutboxBackend({ indexedDB: fakeFactory().factory })).toBeInstanceOf(IndexedDbOutboxBackend);
    expect(browserOutboxBackend({})).toBeNull();
    expect(browserOutboxBackend({ indexedDB: {} })).toBeNull();
    expect(
      browserOutboxBackend({
        get indexedDB(): never {
          throw new Error('blocked');
        },
      }),
    ).toBeNull();
  });
});
