/**
 * A notification tap, as the composition root receives it: the worker's message arrives on
 * `navigator.serviceWorker`, the shell routes there in-app and acknowledges on the transferred port.
 * `app.test.tsx` owns the rest of the shell; this file owns only this seam.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { AppShell } from '../../src/App.tsx';
import type { DaemonConnectionRepository } from '../../src/lib/connections.ts';
import { NOTIFICATION_OPEN_ACK, NOTIFICATION_OPEN_MESSAGE } from '../../src/lib/notification-open.ts';
import { RouterProvider } from '../../src/lib/router.tsx';
import { createAppStore, StoreProvider } from '../../src/lib/store.tsx';
import { MemoryDeviceKeyStore } from '../support/device-keys.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';

class MemoryRepository implements DaemonConnectionRepository {
  readonly values = new Map<string, string>();
  async load(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const patchGlobal = (host: object, name: string, value: unknown): (() => void) => {
  const original = Object.getOwnPropertyDescriptor(host, name);
  Object.defineProperty(host, name, { configurable: true, writable: true, value });
  return () => {
    if (original === undefined) delete (host as Record<string, unknown>)[name];
    else Object.defineProperty(host, name, original);
  };
};

let mounted: Mounted | null = null;
const undo: (() => void)[] = [];
beforeEach(() => {
  window.history.replaceState({}, '', '/');
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  while (undo.length > 0) undo.pop()?.();
  window.history.replaceState({}, '', '/');
});

const mountShell = async (): Promise<void> => {
  const store = await createAppStore({
    repository: new MemoryRepository(),
    deviceKeys: new MemoryDeviceKeyStore(),
    sessionCacheBackend: null,
    scrollMemoryStorage: null,
    connectionHealthEnvironment: {
      now: () => Date.now(),
      schedule: () => () => undefined,
      random: () => 0,
      isOnline: () => true,
    },
    connectionSignals: { listen: () => () => undefined },
  });
  mounted = await mount(
    <RouterProvider>
      <StoreProvider store={store}>
        <AppShell />
      </StoreProvider>
    </RouterProvider>,
  );
};

describe('AppShell notification open', () => {
  it('routes a worker message in the app and acknowledges on its port', async () => {
    // Arrange
    const listeners = new Set<(event: MessageEvent) => void>();
    undo.push(
      patchGlobal(navigator, 'serviceWorker', {
        addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.delete(listener),
      }),
    );
    await mountShell();
    const acks: unknown[] = [];
    const expected = '/notification-target?x=1';

    // Act
    await interact(() => {
      for (const listener of [...listeners])
        listener({
          data: { type: NOTIFICATION_OPEN_MESSAGE, url: expected },
          ports: [{ postMessage: (value: unknown) => acks.push(value) }],
        } as unknown as MessageEvent);
    });

    // Assert
    expect(listeners.size).toBeGreaterThan(0);
    expect(`${window.location.pathname}${window.location.search}`).toBe(expected);
    expect(acks).toEqual([NOTIFICATION_OPEN_ACK]);
  });

  it('listens to nothing in a browser with no service worker', async () => {
    // Arrange
    const before = window.location.pathname;

    // Act
    await mountShell();

    // Assert
    expect('serviceWorker' in navigator).toBe(false);
    expect(window.location.pathname).toBe(before);
  });
});
