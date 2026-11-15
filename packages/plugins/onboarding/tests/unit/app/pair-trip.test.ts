import { describe, expect, it } from 'bun:test';
import {
  browserPairTripStorage,
  clearPairTrip,
  ONBOARDING_PAIR_TRIP_KEY,
  type PairTripStorage,
  readPairTrip,
  rememberPairTrip,
} from '../../../app/pair-trip.ts';

const memory = (): PairTripStorage & { readonly held: Map<string, string> } => {
  const held = new Map<string, string>();
  return {
    held,
    getItem: key => held.get(key) ?? null,
    setItem: (key, value) => void held.set(key, value),
    removeItem: key => void held.delete(key),
  };
};

/** A storage whose every operation throws, as a browser that refuses it does. */
const refusing: PairTripStorage = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
  removeItem: () => {
    throw new Error('denied');
  },
};

describe('the pairing trip’s kept count', () => {
  it('keeps one whole number under its own key and reads it back', () => {
    const storage = memory();
    rememberPairTrip(2, storage);
    expect([...storage.held]).toEqual([[ONBOARDING_PAIR_TRIP_KEY, '2']]);
    expect(readPairTrip(storage)).toBe(2);
    rememberPairTrip(0, storage);
    expect(readPairTrip(storage)).toBe(0);
  });

  it('refuses to keep anything that is not a whole, non-negative count', () => {
    const storage = memory();
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) rememberPairTrip(bad, storage);
    expect(storage.held.size).toBe(0);
  });

  it('reads anything but a plain whole number as nothing, so a code or a tampered value never counts', () => {
    const storage = memory();
    for (const bad of ['', '-1', '1.5', '1e3', ' 2', '2 ', 'abc', 'd1;code=123456', '1234567', '0x10']) {
      storage.held.set(ONBOARDING_PAIR_TRIP_KEY, bad);
      expect(readPairTrip(storage)).toBeUndefined();
    }
    expect(readPairTrip(memory())).toBeUndefined();
  });

  it('forgets the trip once it is over', () => {
    const storage = memory();
    rememberPairTrip(1, storage);
    clearPairTrip(storage);
    expect(storage.held.size).toBe(0);
    expect(readPairTrip(storage)).toBeUndefined();
  });

  it('is never a failure where storage is absent or refuses: memory still holds the count', () => {
    expect(() => rememberPairTrip(1, undefined)).not.toThrow();
    expect(() => clearPairTrip(undefined)).not.toThrow();
    expect(readPairTrip(undefined)).toBeUndefined();
    expect(() => rememberPairTrip(1, refusing)).not.toThrow();
    expect(() => clearPairTrip(refusing)).not.toThrow();
    expect(readPairTrip(refusing)).toBeUndefined();
  });

  it('uses this browser’s storage when it has a whole one, and none when it is missing, partial or throws on access', () => {
    const host = globalThis as { localStorage?: unknown };
    const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const stand = (value: unknown): void =>
      void Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true });
    try {
      const whole = memory();
      stand(whole);
      expect(browserPairTripStorage()).toBe(whole);
      stand({ getItem: () => null, setItem: () => undefined });
      expect(browserPairTripStorage()).toBeUndefined();
      stand(undefined);
      expect(browserPairTripStorage()).toBeUndefined();
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => {
          throw new Error('private mode');
        },
      });
      expect(browserPairTripStorage()).toBeUndefined();
    } finally {
      if (before === undefined) Reflect.deleteProperty(host, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', before);
    }
  });
});
