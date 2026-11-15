import { afterEach, describe, it } from 'bun:test';
import should from 'should';

import {
  browserNotificationSurface,
  subscribeNotificationPermission,
} from '../../../app/lib/browser-notification-surface.ts';

/** The browser globals a test stands in for, put back exactly as they were. */
const GLOBALS = ['Notification', 'navigator', 'addEventListener', 'removeEventListener'] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

const setGlobal = (name: (typeof GLOBALS)[number], value: unknown): void => {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
};

const removeGlobal = (name: (typeof GLOBALS)[number]): void => {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Reflect.deleteProperty(globalThis, name);
};

afterEach(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  saved.clear();
});

/** A `Notification` constructor whose permission and requests the test controls. */
const fakeNotification = (permission: string, afterRequest = permission) => {
  const made: { title: string; options: unknown }[] = [];
  let requests = 0;
  class FakeNotification {
    static permission = permission;
    static requestPermission = async (): Promise<string> => {
      requests += 1;
      FakeNotification.permission = afterRequest;
      return afterRequest;
    };
    onclick = null;
    constructor(title: string, options: unknown) {
      made.push({ title, options });
    }
    close(): void {}
  }
  return { FakeNotification, made, requests: () => requests };
};

describe('browserNotificationSurface', () => {
  it('should read the browser’s permission as it stands, and say unsupported where there is no Notification', () => {
    // Arrange
    const surface = browserNotificationSurface(() => undefined);
    removeGlobal('Notification');

    // Act / Assert
    should(surface.permission()).equal('unsupported');
    setGlobal('Notification', fakeNotification('granted').FakeNotification);
    should(surface.permission()).equal('granted');
  });

  it('should ask the reader for permission and report what they chose, never asking where unsupported', async () => {
    // Arrange
    const surface = browserNotificationSurface(() => undefined);
    removeGlobal('Notification');

    // Act
    const unsupported = await surface.requestPermission();
    const fake = fakeNotification('default', 'denied');
    setGlobal('Notification', fake.FakeNotification);
    const chosen = await surface.requestPermission();

    // Assert
    should(unsupported).equal('unsupported');
    should(chosen).equal('denied');
    should(fake.requests()).equal(1);
  });

  it('should find the page’s own service-worker registration, or none without one', async () => {
    // Arrange
    const surface = browserNotificationSurface(() => undefined);
    const registration = { showNotification: async () => undefined };

    // Act / Assert
    setGlobal('navigator', {});
    should(await surface.registration()).be.null();
    setGlobal('navigator', { serviceWorker: { getRegistration: async () => undefined } });
    should(await surface.registration()).be.null();
    setGlobal('navigator', { serviceWorker: { getRegistration: async () => registration } });
    should(await surface.registration()).equal(registration);
    removeGlobal('navigator');
    should(await surface.registration()).be.null();
  });

  it('should show a page-level notification through the constructor, with no fallback where it is absent', () => {
    // Arrange
    const fake = fakeNotification('granted');
    setGlobal('Notification', fake.FakeNotification);
    const options = { icon: 'i', badge: 'b', body: 'text', tag: 't', renotify: true };

    // Act
    const present = browserNotificationSurface(() => undefined);
    const shown = present.showOnPage?.('Build failed', options);
    removeGlobal('Notification');
    const absent = browserNotificationSurface(() => undefined);

    // Assert
    should(shown).be.ok();
    should(fake.made).deepEqual([{ title: 'Build failed', options }]);
    should(absent.showOnPage).be.null();
  });

  it('should hand a page-level click to the in-app navigation it was given', () => {
    // Arrange
    const went: string[] = [];
    const surface = browserNotificationSurface(path => void went.push(path));

    // Act
    surface.navigate('/d/daemon-a/agenda');

    // Assert
    should(went).deepEqual(['/d/daemon-a/agenda']);
  });
});

describe('subscribeNotificationPermission', () => {
  /** A page whose window and Permissions API record who listens. */
  const page = (permissions: unknown) => {
    const added: string[] = [];
    const removed: string[] = [];
    setGlobal('addEventListener', (name: string) => void added.push(name));
    setGlobal('removeEventListener', (name: string) => void removed.push(name));
    setGlobal('navigator', { permissions });
    return { added, removed };
  };

  it('should listen for the page’s focus and visibility, and stop listening when told', () => {
    // Arrange
    const { added, removed } = page(undefined);

    // Act
    const stop = subscribeNotificationPermission(() => undefined);
    should(added).deepEqual(['focus', 'visibilitychange']);
    should(removed).deepEqual([]);
    stop();

    // Assert
    should(removed).deepEqual(['focus', 'visibilitychange']);
  });

  it('should also follow the browser’s own permission change event, and let go of it on stop', async () => {
    // Arrange
    const events: string[] = [];
    const status = {
      addEventListener: (name: string) => void events.push(`add ${name}`),
      removeEventListener: (name: string) => void events.push(`remove ${name}`),
    };
    const queried: unknown[] = [];
    page({
      query: async (descriptor: unknown) => {
        queried.push(descriptor);
        return status;
      },
    });

    // Act
    const stop = subscribeNotificationPermission(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    stop();

    // Assert
    should(queried).deepEqual([{ name: 'notifications' }]);
    should(events).deepEqual(['add change', 'remove change']);
  });

  it('should carry on with focus and visibility alone when the permission query fails or does not exist', async () => {
    // Arrange
    const refused = page({ query: () => Promise.reject(new Error('not allowed')) });
    const stopRefused = subscribeNotificationPermission(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    stopRefused();
    const refusedRemoved = [...refused.removed];

    const thrown = page({
      query: () => {
        throw new Error('no Permissions API');
      },
    });

    // Act
    const stopThrown = subscribeNotificationPermission(() => undefined);
    stopThrown();

    // Assert
    should(refusedRemoved).deepEqual(['focus', 'visibilitychange']);
    should(thrown.removed).deepEqual(['focus', 'visibilitychange']);
  });
});
