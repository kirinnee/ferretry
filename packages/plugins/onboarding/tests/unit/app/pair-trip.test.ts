import { describe, expect, it } from 'bun:test';
import {
  browserPairTripStorage,
  clearPairTrip,
  hasNewPairing,
  ONBOARDING_PAIR_TRIP_KEY,
  pairingMark,
  pairingMarks,
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

describe('the pairing trip’s kept marks', () => {
  it('keeps one short list of marks under its own key and reads it back', () => {
    const storage = memory();
    const marks = pairingMarks([
      { daemon: 'd1', deviceId: 'dev-a' },
      { daemon: 'd2', deviceId: 'dev-b' },
    ]);
    rememberPairTrip(marks, storage);
    expect([...storage.held.keys()]).toEqual([ONBOARDING_PAIR_TRIP_KEY]);
    expect(readPairTrip(storage)).toEqual(marks);
    rememberPairTrip([], storage);
    expect(readPairTrip(storage)).toEqual([]);
  });

  it('refuses to keep a list that is too long or holds an oversized mark', () => {
    const storage = memory();
    rememberPairTrip(
      Array.from({ length: 41 }, (_, index) => `d${index}`),
      storage,
    );
    rememberPairTrip(['x'.repeat(301)], storage);
    expect(storage.held.size).toBe(0);
  });

  it('reads anything but a short list of strings as nothing, so a code or a tampered value never counts', () => {
    const storage = memory();
    const tooMany = JSON.stringify(Array.from({ length: 41 }, (_, index) => `d${index}`));
    for (const bad of [
      '',
      '2',
      'abc',
      'd1;code=123456',
      '{"a":1}',
      '[1,2]',
      '["a",1]',
      tooMany,
      '["' + 'x'.repeat(301) + '"]',
    ]) {
      storage.held.set(ONBOARDING_PAIR_TRIP_KEY, bad);
      expect(readPairTrip(storage)).toBeUndefined();
    }
    expect(readPairTrip(memory())).toBeUndefined();
  });

  it('tells a new pairing from one already held: a new machine, the same machine paired AGAIN, or one that took another’s place', () => {
    const before = [
      { daemon: 'd1', deviceId: 'dev-a' },
      { daemon: 'd2', deviceId: 'dev-b' },
    ];
    const known = new Set(pairingMarks(before));
    expect(hasNewPairing(before, known)).toBe(false);
    expect(hasNewPairing([], known)).toBe(false);
    // A new machine.
    expect(hasNewPairing([...before, { daemon: 'd3', deviceId: 'dev-c' }], known)).toBe(true);
    // A re-pair replaces the entry: the same count, the same machine, a fresh device grant.
    expect(hasNewPairing([{ daemon: 'd1', deviceId: 'dev-z' }, before[1]!], known)).toBe(true);
    // At the limit a pairing evicts another: the same count again.
    expect(hasNewPairing([before[0]!, { daemon: 'd9', deviceId: 'dev-q' }], known)).toBe(true);
    expect(pairingMark({ daemon: 'd1' })).not.toBe(pairingMark({ daemon: 'd1', deviceId: 'dev-a' }));
  });

  it('forgets the trip once it is over', () => {
    const storage = memory();
    rememberPairTrip(['d1'], storage);
    clearPairTrip(storage);
    expect(storage.held.size).toBe(0);
    expect(readPairTrip(storage)).toBeUndefined();
  });

  it('is never a failure where storage is absent or refuses: memory still holds the marks', () => {
    expect(() => rememberPairTrip(['d1'], undefined)).not.toThrow();
    expect(() => clearPairTrip(undefined)).not.toThrow();
    expect(readPairTrip(undefined)).toBeUndefined();
    expect(() => rememberPairTrip(['d1'], refusing)).not.toThrow();
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
