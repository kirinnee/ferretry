import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { browserFullscreenPort } from '../../../src/ui/lib/fullscreen.ts';

type Listener = () => void;

interface FakeDocument {
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => Promise<void>;
  readonly listeners: Map<string, Set<Listener>>;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
}

const fakeDocument = (extra: Partial<FakeDocument> = {}): FakeDocument => {
  const listeners = new Map<string, Set<Listener>>();
  return {
    listeners,
    addEventListener: (type, listener) => {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
    ...extra,
  };
};

const g = globalThis as unknown as { document?: unknown; navigator?: unknown };
let savedDocument: unknown;
let savedNavigator: PropertyDescriptor | undefined;

const setNavigator = (value: unknown): void => {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
};

beforeEach(() => {
  savedDocument = g.document;
  savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
});

afterEach(() => {
  g.document = savedDocument;
  if (savedNavigator === undefined) Reflect.deleteProperty(globalThis, 'navigator');
  else Object.defineProperty(globalThis, 'navigator', savedNavigator);
});

const element = (shape: Record<string, unknown>): HTMLElement => shape as unknown as HTMLElement;

describe('browserFullscreenPort', () => {
  it('can request an element that has the standard or the prefixed call, and no other', () => {
    expect(browserFullscreenPort.canRequest(element({ requestFullscreen: () => Promise.resolve() }))).toBe(true);
    expect(browserFullscreenPort.canRequest(element({ webkitRequestFullscreen: () => undefined }))).toBe(true);
    expect(browserFullscreenPort.canRequest(element({}))).toBe(false);
  });

  it('requests with the standard call, hiding the navigation UI, then asks for Escape', async () => {
    const calls: unknown[] = [];
    const locked: string[][] = [];
    setNavigator({
      keyboard: {
        lock: (codes: string[]) => {
          locked.push(codes);
          return Promise.resolve();
        },
      },
    });
    await browserFullscreenPort.request(
      element({
        requestFullscreen: (options: unknown) => {
          calls.push(options);
          return Promise.resolve();
        },
      }),
    );
    expect(calls).toEqual([{ navigationUI: 'hide' }]);
    expect(locked).toEqual([['Escape']]);
  });

  it('falls back to the prefixed request, and survives an element with neither the call nor a keyboard', async () => {
    let prefixed = 0;
    setNavigator({});
    await browserFullscreenPort.request(
      element({
        webkitRequestFullscreen: () => {
          prefixed += 1;
        },
      }),
    );
    expect(prefixed).toBe(1);
    await browserFullscreenPort.request(element({}));
    expect(prefixed).toBe(1);
  });

  it('keeps full screen when the keyboard lock is refused, whether it rejects or throws', async () => {
    setNavigator({ keyboard: { lock: () => Promise.reject(new Error('refused')) } });
    await browserFullscreenPort.request(element({ requestFullscreen: () => Promise.resolve() }));
    setNavigator({
      keyboard: {
        lock: () => {
          throw new Error('blocked');
        },
      },
    });
    await browserFullscreenPort.request(element({ requestFullscreen: () => Promise.resolve() }));
  });

  it('exits with the standard call and releases the keyboard', async () => {
    let unlocked = 0;
    let exited = 0;
    setNavigator({ keyboard: { unlock: () => (unlocked += 1) } });
    g.document = fakeDocument({
      exitFullscreen: () => {
        exited += 1;
        return Promise.resolve();
      },
    });
    await browserFullscreenPort.exit();
    expect({ unlocked, exited }).toEqual({ unlocked: 1, exited: 1 });
  });

  it('exits with the prefixed call when there is no standard one', async () => {
    let exited = 0;
    setNavigator({});
    g.document = fakeDocument({
      webkitExitFullscreen: () => {
        exited += 1;
        return Promise.resolve();
      },
    });
    await browserFullscreenPort.exit();
    expect(exited).toBe(1);
    g.document = fakeDocument();
    await browserFullscreenPort.exit();
    expect(exited).toBe(1);
  });

  it('reports the standard full-screen element, then the prefixed one, then none', () => {
    const standard = { id: 'standard' } as unknown as Element;
    const prefixed = { id: 'prefixed' } as unknown as Element;
    g.document = fakeDocument({ fullscreenElement: standard, webkitFullscreenElement: prefixed });
    expect(browserFullscreenPort.current()).toBe(standard);
    g.document = fakeDocument({ fullscreenElement: null, webkitFullscreenElement: prefixed });
    expect(browserFullscreenPort.current()).toBe(prefixed);
    g.document = fakeDocument();
    expect(browserFullscreenPort.current()).toBeNull();
  });

  it('listens to both change events and stops listening on unsubscribe', () => {
    const doc = fakeDocument();
    g.document = doc;
    let heard = 0;
    const stop = browserFullscreenPort.subscribe(() => (heard += 1));
    for (const type of ['fullscreenchange', 'webkitfullscreenchange']) {
      expect(doc.listeners.get(type)?.size).toBe(1);
      for (const listener of doc.listeners.get(type) ?? []) listener();
    }
    expect(heard).toBe(2);
    stop();
    expect(doc.listeners.get('fullscreenchange')?.size).toBe(0);
    expect(doc.listeners.get('webkitfullscreenchange')?.size).toBe(0);
  });
});
