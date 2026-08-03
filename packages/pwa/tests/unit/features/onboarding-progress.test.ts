/**
 * Resuming setup, and refusing to invent progress that was never made.
 *
 * The failure this suite exists to prevent is the benign one: reading damaged
 * storage as "they finished" and dropping someone who installed nothing onto a
 * pairing screen with nothing to pair.
 */

import { describe, expect, it } from 'bun:test';

import {
  browserOnboardingStorage,
  FRESH_ONBOARDING_PROGRESS,
  ONBOARDING_PROGRESS_KEY,
  OnboardingProgressStore,
  type OnboardingProgressStorage,
  parseOnboardingProgress,
} from '../../../src/features/onboarding/onboarding-progress.ts';

const stored = (value: unknown): string => JSON.stringify(value);

class MemoryStorage implements OnboardingProgressStorage {
  readonly writes: string[] = [];
  constructor(private value: string | null = null) {}
  getItem(): string | null {
    return this.value;
  }
  setItem(_key: string, next: string): void {
    this.value = next;
    this.writes.push(next);
  }
}

class HostileStorage implements OnboardingProgressStorage {
  getItem(): string | null {
    throw new Error('storage is denied in this context');
  }
  setItem(): void {
    throw new Error('storage is denied in this context');
  }
}

describe('parseOnboardingProgress', () => {
  it('reads a well-formed document back exactly', () => {
    expect(parseOnboardingProgress(stored({ v: 1, current: 'daemon', furthest: 'pair' }))).toEqual({
      v: 1,
      current: 'daemon',
      furthest: 'pair',
    });
  });

  it('starts fresh on anything it cannot fully trust', () => {
    const damaged = [
      null,
      undefined,
      '',
      'not json at all',
      stored(null),
      stored([{ v: 1, current: 'pair', furthest: 'pair' }]),
      stored('done'),
      // Wrong version: the document may mean something else entirely.
      stored({ v: 2, current: 'pair', furthest: 'done' }),
      // Out of range / unknown steps, in both fields.
      stored({ v: 1, current: 'billing', furthest: 'done' }),
      stored({ v: 1, current: 'install', furthest: 7 }),
      stored({ v: 1, current: 'install' }),
      // Self-inconsistent: further along than the furthest point ever reached.
      stored({ v: 1, current: 'done', furthest: 'daemon' }),
    ];
    for (const raw of damaged) {
      expect(parseOnboardingProgress(raw)).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    }
  });
});

describe('OnboardingProgressStore', () => {
  it('hydrates once, publishes moves, and remembers the furthest point', () => {
    const storage = new MemoryStorage(stored({ v: 1, current: 'daemon', furthest: 'daemon' }));
    const store = new OnboardingProgressStore({ storage });
    const seen: string[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.snapshot().current));

    expect(store.snapshot().current).toBe('daemon');
    // Identity-stable between commits, so React does not re-render on a read.
    expect(store.snapshot()).toBe(store.snapshot());

    store.goTo('pair');
    expect(store.snapshot()).toEqual({ v: 1, current: 'pair', furthest: 'pair' });
    store.goTo('install');
    // Stepping back does NOT erase where they got to.
    expect(store.snapshot()).toEqual({ v: 1, current: 'install', furthest: 'pair' });
    expect(seen).toEqual(['pair', 'install']);
    expect(JSON.parse(storage.writes[storage.writes.length - 1] ?? '{}')).toEqual({
      v: 1,
      current: 'install',
      furthest: 'pair',
    });

    unsubscribe();
    store.goTo('done');
    expect(seen).toEqual(['pair', 'install']);
  });

  it('survives a reload by rehydrating from the same key', () => {
    const storage = new MemoryStorage();
    new OnboardingProgressStore({ storage }).goTo('daemon');
    // A new tab, hours later, with only storage between them.
    expect(new OnboardingProgressStore({ storage }).snapshot()).toEqual({
      v: 1,
      current: 'daemon',
      furthest: 'daemon',
    });
    expect(ONBOARDING_PROGRESS_KEY).toBe('fy-onboarding-v1');
  });

  it('lets an arrival place the reader without rewriting their history', () => {
    const storage = new MemoryStorage(stored({ v: 1, current: 'install', furthest: 'install' }));
    const store = new OnboardingProgressStore({ storage, entry: 'pair' });

    // A tab opened from a pairing link is past install whatever storage says…
    expect(store.snapshot()).toEqual({ v: 1, current: 'pair', furthest: 'pair' });
    // …and merely opening the link wrote nothing.
    expect(storage.writes).toEqual([]);
  });

  it('keeps working when storage is absent or refuses', () => {
    const withoutStorage = new OnboardingProgressStore({ storage: undefined });
    expect(withoutStorage.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    withoutStorage.goTo('pair');
    expect(withoutStorage.snapshot().current).toBe('pair');

    const hostile = new OnboardingProgressStore({ storage: new HostileStorage() });
    expect(hostile.snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    // A refused write is an ordinary browser condition, not a setup failure.
    expect(hostile.goTo('daemon').current).toBe('daemon');
  });

  it('defaults to the browser store, and accepts a browser that has none', () => {
    expect(browserOnboardingStorage()).toBe(globalThis.localStorage as unknown as OnboardingProgressStorage);
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: 'not a function' } });
    try {
      expect(browserOnboardingStorage()).toBeUndefined();
      // The default path, exercised: no storage seam passed at all.
      expect(new OnboardingProgressStore().snapshot()).toEqual({ ...FRESH_ONBOARDING_PROGRESS });
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'localStorage');
    }
  });
});
