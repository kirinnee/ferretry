import { afterEach, describe, expect, test } from 'bun:test';
import { ASK_PIN_KEY, type AskPinStorage, readAskPinned, writeAskPinned } from '../../src/lib/agenda-ask-pin.ts';

const memory = (seed: Record<string, string> = {}): AskPinStorage & { readonly values: Record<string, string> } => {
  const values = { ...seed };
  return {
    values,
    getItem: key => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value;
    },
  };
};

const refusing: AskPinStorage = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('full');
  },
};

const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  if (realStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
  else Object.defineProperty(globalThis, 'localStorage', realStorage);
});

describe('the pinned ask (ⓘ)', () => {
  test('is pinned only when this device said so', () => {
    expect(readAskPinned(memory({ [ASK_PIN_KEY]: '1' }))).toBe(true);
    expect(readAskPinned(memory({ [ASK_PIN_KEY]: '0' }))).toBe(false);
    expect(readAskPinned(memory({ [ASK_PIN_KEY]: 'yes' }))).toBe(false);
    expect(readAskPinned(memory())).toBe(false);
    expect(readAskPinned(undefined)).toBe(false);
  });

  test('remembers the choice, and a storage that refuses only means it is not remembered', () => {
    const store = memory();
    writeAskPinned(true, store);
    expect(store.values[ASK_PIN_KEY]).toBe('1');
    writeAskPinned(false, store);
    expect(store.values[ASK_PIN_KEY]).toBe('0');
    expect(() => writeAskPinned(true, refusing)).not.toThrow();
    expect(readAskPinned(refusing)).toBe(false);
    expect(() => writeAskPinned(true, undefined)).not.toThrow();
  });

  test('treats a browser with no storage, or one whose storage throws, as not pinned', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError');
      },
    });
    expect(readAskPinned()).toBe(false);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: 1 } });
    expect(readAskPinned()).toBe(false);
    const store = memory();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
    writeAskPinned(true);
    expect(readAskPinned()).toBe(true);
  });
});
