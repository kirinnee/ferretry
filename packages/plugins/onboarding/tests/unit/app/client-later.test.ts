import { describe, expect, test } from 'bun:test';
import type { Instant } from '@ferretry/std';
import { CLIENT_LATER_KEY, readLater, rememberLater } from '../../../app/features/setup-flow/client-later.ts';

const AT = '2026-11-19T09:00:00.000Z' as Instant;
const memory = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
};

describe('client pages left for later', () => {
  test('remembers a step key and reads it back, accumulating', () => {
    const store = memory();
    expect(rememberLater(store, 'fake-pack.look', AT)).toBe(true);
    expect(rememberLater(store, 'onboarding.appearance', AT)).toBe(true);
    expect([...readLater(store)].sort()).toEqual(['fake-pack.look', 'onboarding.appearance']);
    // Keys and instants only.
    expect(JSON.parse(store.map.get(CLIENT_LATER_KEY) ?? '{}')).toEqual({
      format: 1,
      steps: { 'fake-pack.look': AT, 'onboarding.appearance': AT },
    });
  });

  test('damaged, foreign or absent storage reads as nothing left for later; nothing throws', () => {
    expect(readLater(undefined).size).toBe(0);
    const store = memory();
    store.map.set(CLIENT_LATER_KEY, '{not json');
    expect(readLater(store).size).toBe(0);
    store.map.set(CLIENT_LATER_KEY, JSON.stringify({ format: 2, steps: { 'a.b': AT } }));
    expect(readLater(store).size).toBe(0);
    // A good write over a damaged value recovers.
    expect(rememberLater(store, 'fake-pack.look', AT)).toBe(true);
    expect([...readLater(store)]).toEqual(['fake-pack.look']);
  });

  test('storage that refuses, a bad key and no storage are reported, never thrown', () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
    };
    expect(rememberLater(refusing, 'fake-pack.look', AT)).toBe(false);
    expect(rememberLater(memory(), 'NOT A KEY', AT)).toBe(false);
    expect(rememberLater(undefined, 'fake-pack.look', AT)).toBe(false);
  });
});
