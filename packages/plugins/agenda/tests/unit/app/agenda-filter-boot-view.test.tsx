/**
 * AGENDA WRITES THE WORKER'S FILTER DOCUMENT AT APP BOOT (shell contract S6). Without it the closed-app worker would show
 * everything until the person's next settings change. The view is a device view: it draws nothing and, once mounted,
 * writes what this device last chose to the kernel's database, store and key as the v2 document's JSON text.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mount } from '@ferretry/app/testing';
import {
  NOTIFICATION_FILTER_DB,
  NOTIFICATION_FILTER_KEY,
  NOTIFICATION_FILTER_STORE,
  readNotificationFilterDocument,
} from '@ferretry/kernel/contract/notification-filter';
import half from '../../../app/index.ts';
import { deviceFilterStore } from '../../../app/lib/device-filter-store.ts';
import { NOTIFICATION_FILTER_PREFERENCES_KEY } from '../../../app/lib/notification-filter.ts';
import { AgendaFilterBootView } from '../../../app/views/agenda-filter-boot-view.tsx';

const STORED = JSON.stringify({
  version: 1,
  categories: { 'needs-you': true, finished: false, failed: true, 'new-device': true },
  quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 },
  machines: { fy_daemon_muted: false },
});

const puts: { db: string; store: string; key: string; value: unknown }[] = [];
const saved = {
  localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  indexedDB: Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'),
};

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => (key === NOTIFICATION_FILTER_PREFERENCES_KEY ? STORED : null),
      setItem: () => {},
    },
  });
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open: (db: string) => {
        const request: Record<string, unknown> = {};
        const database = {
          objectStoreNames: { contains: () => true },
          transaction: (store: string) => {
            const transaction: Record<string, (() => void) | null> = { oncomplete: null };
            return Object.assign(transaction, {
              objectStore: () => ({
                put: (value: unknown, key: string) => {
                  puts.push({ db, store, key, value });
                  queueMicrotask(() => transaction.oncomplete?.());
                },
              }),
            });
          },
        };
        request.result = database;
        queueMicrotask(() => (request.onsuccess as () => void)?.());
        return request;
      },
    },
  });
});

// The store reads this browser's storage once, when first made: made here, before the test harness installs its own DOM.
beforeAll(() => {
  deviceFilterStore();
});

afterAll(() => {
  for (const [name, descriptor] of Object.entries(saved)) {
    if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

describe('Agenda’s notification-filter device view', () => {
  it('is declared beside the deep-link view, so the shell mounts it once at the frame root', () => {
    expect(Object.keys(half.shell.device ?? {}).sort()).toEqual(['deep-link', 'notification-filter']);
  });

  it('draws nothing and writes the stored preferences to the worker’s document on mount', async () => {
    const view = await mount(<AgendaFilterBootView navigate={() => {}} />);
    for (let i = 0; i < 10; i += 1) await new Promise(resolve => setTimeout(resolve, 0));
    await view.unmount();

    expect(puts).toHaveLength(1);
    const [put] = puts;
    expect(put?.db).toBe(NOTIFICATION_FILTER_DB);
    expect(put?.store).toBe(NOTIFICATION_FILTER_STORE);
    expect(put?.key).toBe(NOTIFICATION_FILTER_KEY);
    // The worker's own reader parses it: finished is hidden, the muted machine and the quiet hours carry over.
    expect(readNotificationFilterDocument(put?.value)).toEqual({
      version: 2,
      hiddenKinds: ['completed'],
      mutedDaemons: ['fy_daemon_muted'],
      quietHours: { enabled: true, startMinute: 22 * 60, endMinute: 7 * 60 },
    });
  });
});
