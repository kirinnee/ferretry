/**
 * A notification tap, as an app root receives it: the worker's message arrives on `navigator.serviceWorker`, the
 * entry point's inbox (`attachNotificationOpens`) holds it, and the page routes there in-app through the shell's
 * router and acknowledges on the transferred port.
 *
 * Today this mounted the whole `AppShell` with its store; the shell's root is not this half's, and in 5.0 nothing
 * mounts these yet (GAP(notification-open) in NEEDS-APP-SHELL.txt). So this proves the same seam as a root would wire
 * it: the inbox in `NotificationOpenContext`, `useNotificationOpen` routing through `useRouter().navigate`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { NotificationOpenContext, useNotificationOpen } from '../../../app/hooks/use-notification-open.ts';
import {
  attachNotificationOpens,
  NOTIFICATION_OPEN_ACK,
  NOTIFICATION_OPEN_MESSAGE,
  NotificationOpenInbox,
  type NotificationOpenSource,
} from '../../../app/lib/notification-open.ts';
import { useRouter } from '../../../app/shell.ts';
import { ensureDom, interact, type Mounted, mount, RouterProvider } from '@ferretry/app/testing';

ensureDom();

let mounted: Mounted | null = null;
beforeEach(() => {
  window.history.replaceState({}, '', '/');
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  window.history.replaceState({}, '', '/');
});

/** The root's routing: every open the inbox holds is navigated to in the app. */
function OpenRouting() {
  const { navigate } = useRouter();
  useNotificationOpen(null, window.location.origin, navigate);
  return null;
}

const mountRoot = async (source: NotificationOpenSource | null): Promise<void> => {
  const inbox = attachNotificationOpens(new NotificationOpenInbox(window.location.origin), source);
  mounted = await mount(
    <RouterProvider>
      <NotificationOpenContext.Provider value={inbox}>
        <OpenRouting />
      </NotificationOpenContext.Provider>
    </RouterProvider>,
  );
};

describe('the app root’s notification open', () => {
  it('routes a worker message in the app and acknowledges on its port', async () => {
    // Arrange
    const listeners = new Set<(event: MessageEvent) => void>();
    const worker: NotificationOpenSource = {
      addEventListener: (_type, listener) => listeners.add(listener),
    };
    await mountRoot(worker);
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
    await mountRoot(null);

    // Assert
    expect('serviceWorker' in navigator).toBe(false);
    expect(window.location.pathname).toBe(before);
  });
});
