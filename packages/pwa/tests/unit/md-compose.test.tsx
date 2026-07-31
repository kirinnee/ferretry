import { describe, expect, it } from 'bun:test';
import { useMdComposePref } from '../../src/lib/md-compose.ts';
import {
  MD_COMPOSE_DEFAULT,
  MD_COMPOSE_KEY,
  parseMdComposePref,
  readMdComposePref,
  writeMdComposePref,
} from '../../src/lib/md-compose.ts';
import { render, run } from '../support/react.ts';

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class BrowserWindow {
  readonly listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

const withBrowser = (body: (storage: MemoryStorage, browser: BrowserWindow) => void): void => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new MemoryStorage();
  const browser = new BrowserWindow();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    body(storage, browser);
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
};

function PreferenceProbe() {
  return <output>{useMdComposePref()}</output>;
}

const clearVolatilePreference = (browser: BrowserWindow): void => {
  const renderer = render(<PreferenceProbe />);
  const event = Object.assign(new Event('storage'), { key: MD_COMPOSE_KEY }) as StorageEvent;
  run(() => browser.dispatchEvent(event));
  run(() => renderer.unmount());
};

describe('Markdown composer preference', () => {
  it('accepts only explicit on/off persisted values', () => {
    expect(parseMdComposePref('on')).toBe('on');
    expect(parseMdComposePref('off')).toBe('off');
    expect(parseMdComposePref('enabled')).toBe(MD_COMPOSE_DEFAULT);
    expect(parseMdComposePref(null)).toBe(MD_COMPOSE_DEFAULT);
  });

  it('hydrates safely and retains a same-page value when persistence is denied', () => {
    withBrowser((storage, browser) => {
      storage.setItem(MD_COMPOSE_KEY, 'on');
      clearVolatilePreference(browser);
      expect(readMdComposePref()).toBe('on');

      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => {
          throw new Error('blocked storage getter');
        },
      });
      clearVolatilePreference(browser);
      expect(readMdComposePref()).toBe(MD_COMPOSE_DEFAULT);

      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
          getItem: () => {
            throw new Error('privacy mode');
          },
          setItem: () => {
            throw new Error('quota exceeded');
          },
        },
      });
      clearVolatilePreference(browser);
      expect(readMdComposePref()).toBe(MD_COMPOSE_DEFAULT);
      writeMdComposePref('on');
      expect(readMdComposePref()).toBe('on');
    });
  });
});
