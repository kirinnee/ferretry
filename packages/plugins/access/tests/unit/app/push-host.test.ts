import { describe, expect, it } from 'bun:test';
import { browserPushHost } from '../../../app/lib/push-host.ts';

/** Sets browser globals for one test and puts back exactly what was there (the unit suite shares one process). */
function stubbed(globals: Readonly<Record<string, unknown>>): () => void {
  const saved = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, descriptor);
    }
  };
}

/** A browser that can hold a push subscription: secure, a service-worker container, a push manager. */
const pushCapable = (register: (url: string, options: { scope: string }) => Promise<unknown>) => ({
  window: { isSecureContext: true, PushManager: class {}, location: { origin: 'https://pwa.example.test' } },
  navigator: {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
    serviceWorker: { register, getRegistrations: async () => [] },
  },
});

describe('the page’s push host', () => {
  it('keeps working memory-only when the browser refuses its storage, and shares its two stores between every host', () => {
    // Arrange: a browser whose storage throws on the first touch (a blocked-cookies profile).
    const restore = stubbed({ localStorage: undefined });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('storage is blocked');
      },
    });
    try {
      // Act
      const first = browserPushHost();
      const second = browserPushHost();

      // Assert: the page's switch and its banner must agree, so there is one of each.
      expect(second.devices).toBe(first.devices);
      expect(second.preferences).toBe(first.preferences);
    } finally {
      restore();
    }
  });

  it('reports the notification permission as the browser holds it, and unsupported where there is none', () => {
    const host = browserPushHost();
    const states = ['default', 'granted', 'denied'] as const;
    for (const permission of states) {
      const restore = stubbed({ Notification: { permission } });
      try {
        expect(host.permission()).toBe(permission);
      } finally {
        restore();
      }
    }
    const restore = stubbed({ Notification: undefined });
    try {
      expect(host.permission()).toBe('unsupported');
    } finally {
      restore();
    }
  });

  it('asks the browser for permission only where it can, and answers with what the person chose', async () => {
    const host = browserPushHost();
    const gone = stubbed({ Notification: undefined });
    try {
      expect(await host.requestPermission()).toBe('unsupported');
    } finally {
      gone();
    }
    let asked = 0;
    const notification = {
      permission: 'default',
      requestPermission: async () => {
        asked += 1;
        notification.permission = 'denied';
        return 'denied';
      },
    };
    const restore = stubbed({ Notification: notification });
    try {
      expect(await host.requestPermission()).toBe('denied');
      expect(asked).toBe(1);
    } finally {
      restore();
    }
  });

  it('offers no enrolment where the browser cannot do Web Push, whichever piece is missing', () => {
    const host = browserPushHost();
    const good = pushCapable(async () => ({}));
    const withoutWindow = stubbed({ window: undefined, navigator: good.navigator });
    try {
      expect(host.enrolment('Studio')).toBeNull();
    } finally {
      withoutWindow();
    }
    const insecure = stubbed({ window: { ...good.window, isSecureContext: false }, navigator: good.navigator });
    try {
      expect(host.enrolment('Studio')).toBeNull();
    } finally {
      insecure();
    }
    const noNavigator = stubbed({ window: good.window, navigator: undefined });
    try {
      expect(host.enrolment('Studio')).toBeNull();
    } finally {
      noNavigator();
    }
    const noWorkers = stubbed({ window: good.window, navigator: { userAgent: 'x' } });
    try {
      expect(host.enrolment('Studio')).toBeNull();
    } finally {
      noWorkers();
    }
    const noPushManager = stubbed({
      window: { isSecureContext: true, location: good.window.location },
      navigator: good.navigator,
    });
    try {
      expect(host.enrolment('Studio')).toBeNull();
    } finally {
      noPushManager();
    }
  });

  it('enrols through the signed worker, labelled with the machine’s name, naming this browser for the machine', async () => {
    // Arrange
    const registered: Array<{ url: string; scope: string }> = [];
    const good = pushCapable(async (url, options) => {
      registered.push({ url, scope: options.scope });
      return {};
    });
    const restore = stubbed({ window: good.window, navigator: good.navigator });
    try {
      const host = browserPushHost();

      // Act
      const enrolment = host.enrolment('Studio Mac');
      await enrolment?.register('daemon-a' as never).catch(() => undefined);

      // Assert: the machine's label rides on the worker URL, and the device carries the browser's own name.
      expect(enrolment).not.toBeNull();
      // The name is made once with the stores (the first host of the page), so the browser's words are not asserted.
      expect(enrolment?.deviceName()).toMatch(/ · [2-9A-HJKMNP-Z]{4}$/u);
      expect(browserPushHost().enrolment('Other')?.deviceName()).toBe(enrolment?.deviceName());
      expect(registered).toHaveLength(1);
      expect(String(registered[0]?.url)).toContain('/sw.verified.js?');
      expect(String(registered[0]?.url)).toContain('Studio%20Mac');
    } finally {
      restore();
    }
  });
});
